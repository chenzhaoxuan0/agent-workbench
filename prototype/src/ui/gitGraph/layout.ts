/**
 * 提交图泳道布局（纯函数，无 React / DOM）。
 *
 * 算法移植自 ZCode（Apache-2.0）的 packages/ui/src/git-graph/layoutAlgorithm.ts
 * 与 layout.ts（2026-10-17 走查版），按本仓类型与注释风格改写；泳道分配、
 * lane 复用、merge 借道连接点这些核心机制保持原样。出处登记见
 * THIRD-PARTY-NOTICES.md 的 ZCode 条目。
 *
 * 模型：每个提交一个 vertex（rowIndex 即 id），自上而下扫；每个尚未归位的
 * vertex 起一条 branch（一串 line 种子）向下连到它的 parent，parent 未归位
 * 则借这条 branch 继续向下连 parent 的 parent。lane（泳道/颜色）按「起点晚于
 * 某 lane 的终点即可复用」分配，merge 提交的两端都已归位时走借道连接点。
 * 分页窗口之外的 parent（truncated）不画到窗口底部，起一条短边即止。
 */

import type { GitGraphCommit } from "../../core/git.ts";

export interface GraphPoint {
  laneIndex: number;
  rowIndex: number;
}

export interface BranchLineSeed {
  from: GraphPoint;
  to: GraphPoint;
  laneIndex: number;
  sourceHash: string;
  targetHash: string;
  /** false = 先横后竖（本行内横移），true = 先竖后横（跨行斜插） */
  lockedFirst: boolean;
}

interface LaneConnection {
  target: LayoutVertex;
  branch: LayoutBranch;
}

const MISSING_PARENT_ID = -1;

class LayoutBranch {
  readonly colourIndex: number;
  readonly lines: BranchLineSeed[] = [];
  endRowIndex = 0;

  constructor(colourIndex: number) {
    this.colourIndex = colourIndex;
  }

  addLine(from: GraphPoint, to: GraphPoint, sourceHash: string, targetHash: string, lockedFirst: boolean): void {
    this.lines.push({ from, to, laneIndex: this.colourIndex, sourceHash, targetHash, lockedFirst });
  }
}

class LayoutVertex {
  readonly id: number;
  readonly hash: string;
  private readonly parents: LayoutVertex[] = [];
  private nextParentIndex = 0;
  private laneIndex: number | null = null;
  private branch: LayoutBranch | null = null;
  private nextLaneIndex = 0;
  private readonly connections: Array<LaneConnection | undefined> = [];

  constructor(id: number, hash: string) {
    this.id = id;
    this.hash = hash;
  }

  addParent(vertex: LayoutVertex): void {
    this.parents.push(vertex);
  }

  getNextParent(): LayoutVertex | null {
    return this.nextParentIndex < this.parents.length ? (this.parents[this.nextParentIndex] ?? null) : null;
  }

  registerParentProcessed(): void {
    this.nextParentIndex += 1;
  }

  isMerge(): boolean {
    return this.parents.length > 1;
  }

  isNotOnBranch(): boolean {
    return this.branch === null || this.laneIndex === null;
  }

  addToBranch(branch: LayoutBranch, laneIndex: number): void {
    if (this.branch === null) {
      this.branch = branch;
      this.laneIndex = laneIndex;
    }
  }

  getBranch(): LayoutBranch | null {
    return this.branch;
  }

  getLaneIndex(): number {
    return this.laneIndex ?? 0;
  }

  getPoint(): GraphPoint {
    return { laneIndex: this.getLaneIndex(), rowIndex: this.id };
  }

  getNextPoint(): GraphPoint {
    return { laneIndex: this.nextLaneIndex, rowIndex: this.id };
  }

  /** 本行上已有的「借道连接点」：别的 branch 横移进本行时占用的 lane */
  getPointConnectingTo(target: LayoutVertex, branch: LayoutBranch): GraphPoint | null {
    const idx = this.connections.findIndex((c) => c?.target === target && c.branch === branch);
    return idx >= 0 ? { laneIndex: idx, rowIndex: this.id } : null;
  }

  reservePoint(laneIndex: number, target: LayoutVertex, branch: LayoutBranch): void {
    if (laneIndex === this.nextLaneIndex) {
      this.connections[laneIndex] = { target, branch };
      this.nextLaneIndex = laneIndex + 1;
    }
  }

  getWidthLaneIndex(): number {
    return this.nextLaneIndex;
  }
}

function createVertices(commits: readonly GitGraphCommit[]) {
  const missingParent = new LayoutVertex(MISSING_PARENT_ID, "__missing_parent__");
  const vertices = commits.map((commit, index) => new LayoutVertex(index, commit.hash));
  const vertexByHash = new Map(vertices.map((vertex) => [vertex.hash, vertex]));
  for (const [index, commit] of commits.entries()) {
    const vertex = vertices[index]!;
    for (const parentHash of commit.parents) {
      vertex.addParent(vertexByHash.get(parentHash) ?? missingParent);
    }
  }
  return { missingParent, vertices, vertexByHash };
}

/** lane 复用：起点行晚于某 lane 终点行的，直接接管那个 lane */
function getAvailableColour(startAt: number, availableColours: number[]): number {
  const reusable = availableColours.findIndex((endAt) => startAt > endAt);
  if (reusable >= 0) return reusable;
  availableColours.push(0);
  return availableColours.length - 1;
}

/** merge 的借道路径：两端都已归位，沿既有行向下找本 branch 的连接点 */
function determineMergePath(
  startAt: number,
  vertices: LayoutVertex[],
  vertex: LayoutVertex,
  parentVertex: LayoutVertex,
): void {
  const parentBranch = parentVertex.getBranch()!;
  let lastPoint = vertex.getPoint();
  for (let rowIndex = startAt + 1; rowIndex < vertices.length; rowIndex++) {
    const currentVertex = vertices[rowIndex]!;
    const existingPoint = currentVertex.getPointConnectingTo(parentVertex, parentBranch);
    const currentPoint = existingPoint ?? currentVertex.getNextPoint();
    const foundConnection = existingPoint !== null;
    parentBranch.addLine(
      lastPoint,
      currentPoint,
      vertex.hash,
      parentVertex.hash,
      !foundConnection && currentVertex !== parentVertex ? lastPoint.laneIndex < currentPoint.laneIndex : true,
    );
    currentVertex.reservePoint(currentPoint.laneIndex, parentVertex, parentBranch);
    lastPoint = currentPoint;
    if (foundConnection) {
      vertex.registerParentProcessed();
      break;
    }
  }
}

function determineNormalPath(params: {
  startAt: number;
  vertices: LayoutVertex[];
  branches: LayoutBranch[];
  availableColours: number[];
  missingParent: LayoutVertex;
}): void {
  const { startAt, vertices, branches, availableColours, missingParent } = params;
  const vertex = vertices[startAt]!;
  let parentVertex = vertex.getNextParent();
  // 线段的 hash 归属会随接力转移：parent 归位后，branch 继续代表的是 parent 的
  // ancestry，后续线段的 sourceHash 记 parent（hover 高亮按 hash 找相关线）
  let sourceVertex = vertex;
  let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint();
  const branch = new LayoutBranch(getAvailableColour(startAt, availableColours));
  vertex.addToBranch(branch, lastPoint.laneIndex);
  vertex.reservePoint(lastPoint.laneIndex, vertex, branch);

  let rowIndex: number;
  for (rowIndex = startAt + 1; rowIndex < vertices.length; rowIndex++) {
    if (parentVertex === null || parentVertex === missingParent) break;
    const currentVertex = vertices[rowIndex]!;
    const currentPoint =
      parentVertex === currentVertex && !parentVertex.isNotOnBranch() ? currentVertex.getPoint() : currentVertex.getNextPoint();
    branch.addLine(lastPoint, currentPoint, sourceVertex.hash, parentVertex.hash, lastPoint.laneIndex < currentPoint.laneIndex);
    currentVertex.reservePoint(currentPoint.laneIndex, parentVertex, branch);
    lastPoint = currentPoint;
    if (parentVertex === currentVertex) {
      sourceVertex.registerParentProcessed();
      const parentWasAlreadyOnBranch = !parentVertex.isNotOnBranch();
      parentVertex.addToBranch(branch, currentPoint.laneIndex);
      sourceVertex = parentVertex;
      parentVertex = parentVertex.getNextParent();
      if (parentVertex === missingParent) {
        // 分页窗口外的 parent 没有可见节点，不能把线画到窗口底部
        sourceVertex.registerParentProcessed();
        break;
      }
      if (parentVertex === null || parentWasAlreadyOnBranch) break;
    }
  }

  branch.endRowIndex = rowIndex;
  branches.push(branch);
  availableColours[branch.colourIndex] = rowIndex;
}

function determinePath(params: {
  startAt: number;
  vertices: LayoutVertex[];
  branches: LayoutBranch[];
  availableColours: number[];
  missingParent: LayoutVertex;
}): void {
  const vertex = params.vertices[params.startAt]!;
  const parentVertex = vertex.getNextParent();
  if (parentVertex === params.missingParent) {
    vertex.registerParentProcessed();
    return;
  }
  if (parentVertex !== null && vertex.isMerge() && !vertex.isNotOnBranch() && !parentVertex.isNotOnBranch()) {
    determineMergePath(params.startAt, params.vertices, vertex, parentVertex);
    return;
  }
  determineNormalPath(params);
}

function createGitGraphLayoutModel(commits: readonly GitGraphCommit[]) {
  const { missingParent, vertices, vertexByHash } = createVertices(commits);
  const branches: LayoutBranch[] = [];
  const availableColours: number[] = [];
  let index = 0;
  while (index < vertices.length) {
    const vertex = vertices[index]!;
    if (vertex.getNextParent() !== null || vertex.isNotOnBranch()) {
      determinePath({ startAt: index, vertices, branches, availableColours, missingParent });
    } else {
      index += 1;
    }
  }
  return { vertices, vertexByHash, branchLines: branches.flatMap((branch) => branch.lines) };
}

// ---- 像素布局 ---------------------------------------------------------------

export interface GitGraphLayoutRow {
  commit: GitGraphCommit;
  rowIndex: number;
  laneIndex: number;
  x: number;
  y: number;
}

/** 一条可视化连线（一段 bezier/直线），供 hover 时按 relatedHashes 调暗无关线 */
export interface GitGraphLayoutPath {
  id: string;
  laneIndex: number;
  path: string;
  relatedHashes: string[];
}

export interface GitGraphLayout {
  rows: GitGraphLayoutRow[];
  paths: GitGraphLayoutPath[];
  laneCount: number;
  width: number;
  height: number;
  rowHeight: number;
  laneGap: number;
}

const DEFAULT_ROW_HEIGHT = 42;
const DEFAULT_LANE_GAP = 18;
const DEFAULT_LANE_PADDING = 16;
const DEFAULT_TOP_PADDING = 21; // rowHeight/2：首行圆点垂直居中在自己的行里
const DEFAULT_BOTTOM_PADDING = 18;

function buildEdgePath(from: { x: number; y: number }, to: { x: number; y: number }, lockedFirst: boolean): string {
  if (from.x === to.x) return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  const curveOffset = Math.max(14, Math.abs(to.y - from.y) * 0.38);
  // lockedFirst=false：本行内横移（先横后竖）；true：跨行斜插（先竖后横）
  return lockedFirst
    ? `M ${from.x} ${from.y} C ${from.x} ${from.y + curveOffset}, ${to.x} ${from.y + curveOffset}, ${to.x} ${to.y}`
    : `M ${from.x} ${from.y} C ${from.x} ${to.y - curveOffset}, ${to.x} ${to.y - curveOffset}, ${to.x} ${to.y}`;
}

export function layoutGitGraph(commits: readonly GitGraphCommit[]): GitGraphLayout {
  const rowHeight = DEFAULT_ROW_HEIGHT;
  const laneGap = DEFAULT_LANE_GAP;
  const lanePadding = DEFAULT_LANE_PADDING;
  const topPadding = DEFAULT_TOP_PADDING;
  const { vertices, branchLines } = createGitGraphLayoutModel(commits);

  const rows = vertices.map((vertex, rowIndex): GitGraphLayoutRow => {
    const laneIndex = vertex.getLaneIndex();
    return {
      commit: commits[rowIndex]!,
      rowIndex,
      laneIndex,
      x: lanePadding + laneIndex * laneGap,
      y: topPadding + rowIndex * rowHeight,
    };
  });
  const maxRowLaneIndex = rows.reduce((max, row) => Math.max(max, row.laneIndex), 0);
  const maxWidthLaneIndex = vertices.reduce((max, vertex) => Math.max(max, vertex.getWidthLaneIndex() - 1), 0);
  const maxLineLaneIndex = branchLines.reduce((max, line) => Math.max(max, line.from.laneIndex, line.to.laneIndex), 0);
  const laneCount = Math.max(1, maxRowLaneIndex + 1, maxWidthLaneIndex + 1, maxLineLaneIndex + 1);
  const height = topPadding + Math.max(0, commits.length - 1) * rowHeight + DEFAULT_BOTTOM_PADDING;
  const width = lanePadding * 2 + (laneCount - 1) * laneGap;

  const paths = branchLines.map((line, index): GitGraphLayoutPath => {
    const from = { x: lanePadding + line.from.laneIndex * laneGap, y: topPadding + line.from.rowIndex * rowHeight };
    const to = { x: lanePadding + line.to.laneIndex * laneGap, y: topPadding + line.to.rowIndex * rowHeight };
    return {
      id: `${line.sourceHash}:${line.targetHash}:${line.from.rowIndex}:${line.to.rowIndex}:${index}`,
      laneIndex: line.laneIndex,
      path: buildEdgePath(from, to, line.lockedFirst),
      relatedHashes: line.sourceHash === line.targetHash ? [line.sourceHash] : [line.sourceHash, line.targetHash],
    };
  });

  return { rows, paths, laneCount, width, height, rowHeight, laneGap };
}
