import { useState } from "react";
import { Check, FolderOpen, Smartphone } from "lucide-react";
import { useShell } from "../store/useShell.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { sidePaneOccupies } from "../core/sidePaneTabs.ts";
import { openFolder } from "../adapters/daemon/client.ts";
import { useIsMobile } from "./mobile/useIsMobile.ts";
import { ConversationViewSwitch } from "./ConversationViewSwitch.tsx";
import { cn } from "./cn.ts";

/** 图标按钮的统一规格：28px 命中区（ZCode 的 icon-md），14px 图标 */
const iconBtn =
  "rounded-btn p-1.5 text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent";

/**
 * 工作区头部 —— 只留高频操作：单元身份卡（左）＋ 会话形态切换（右）。
 *
 * 低频状态项（工作中 / 历史会话 / 移动端远控 / 后台守护通道）已迁往右侧栏的
 * 底部状态条（见 StatusIndicators.tsx）：它们是「想看时去看」的信息，不是每一步
 * 都要用的操作，常驻头部只会挤占身份与切换的空间。右侧面板的开合钮也不在
 * 这里：展开时在面板 tab 条最右，收起后是右上浮层钮（WorkspaceShell 的
 * SidePaneTopOverlay，与左侧栏折叠浮层镜像）—— 头部只在面板收起时让出
 * pr-12 的对齐带给它。
 *
 * 溢出阶梯（@container，宽→窄依次让位）：① 一句话角色（<1100）② 文件夹
 * （<560）③ 名称 + 对话/TUI 永远留守。「切回手机视图」是唯一回手机布局的
 * 出口，出现即常驻。
 */
export function WorkspaceHeader() {
  const sidebarCollapsed = useShell((s) => s.sidebarCollapsed);

  const { preference, setPreference, windowIsMobile } = useIsMobile();
  const unit = useWorkbench(selectActiveUnit);
  const isSteward = unit?.id === "steward";
  const mainView = useShell((s) => s.mainView);
  // 面板是否占位决定右侧内边距：收起时让出右上浮层重开钮的对齐带（pr-12）
  const paneOpen = useSidePane(
    (s) => sidePaneOccupies(s.scopeUnitId, s.collapsed, mainView === "chat"),
  );

  return (
    <header
      className={cn(
        "@container flex h-12 shrink-0 items-center gap-2 border-b border-line/60 bg-rail transition-[padding] duration-300",
        // 左：折叠时只让出浮层展开钮（pl-3 + w-7 = 40px）加 8px 间隙，名称顶着图标
        // 右侧对齐；右：面板收起时同样让出右上浮层钮的对齐带 —— 与左对称
        sidebarCollapsed ? "pl-12" : "pl-4",
        paneOpen ? "pr-4" : "pr-12",
      )}
      aria-label="单元"
    >
      {/* ---- 左区：单元身份卡片 ---- */}
      {unit ? (
        <div className="flex min-w-0 items-center gap-2">
          {/* 可点击的单元头衔（点击打开单元设置）。
              名称不压缩、不省略号：空间真不够时硬裁（overflow-hidden，无 "…"）；
              一句话角色徽标最先让位（<1100 隐藏，可见时仍有 280px 上限截断） */}
          <button
            onClick={() => useShell.getState().openUnitSettings(unit.id)}
            title="查看与编辑单元设置（身份 / 执行器 / 模型 / AGENTS.md / 渠道）"
            className="group flex min-w-0 items-center gap-2 rounded-btn px-2 py-1 transition hover:bg-line-soft"
          >
            {/* 名字 */}
            <span className="overflow-hidden whitespace-nowrap text-body font-medium text-ink group-hover:text-teal">
              {unit.name}
            </span>
            {/* 身份/角色徽标：最先让位 */}
            <span
              title={isSteward ? undefined : unit.identity?.role || undefined}
              className="hidden @min-[1100px]:block min-w-0 max-w-[280px] shrink-[999] truncate rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-graphite group-hover:bg-teal-tint group-hover:text-teal"
            >
              {isSteward ? "总管" : unit.identity?.role || "bot"}
            </span>
          </button>

          {/* 单元目录：单击直接在资源管理器中打开，路径悬停可见（<560 隐藏——移动端不需要） */}
          {unit && (
            <span className="hidden shrink-0 @min-[560px]:inline-flex">
              <OpenWorkspaceFolder path={unit.rootPath} />
            </span>
          )}
        </div>
      ) : (
        <span className="text-body-sm text-ash">未选择单元</span>
      )}

      {/* ---- 右区：手机切换出口 + 会话形态切换 + 面板开合，整块锚定行尾 ---- */}

      {/* 电脑/手机视图切换通道（解决切到电脑模式后无法切回手机视图的问题）。
          唯一回手机布局的出口：出现即常驻，不参与溢出阶梯 */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {(preference === "desktop" || windowIsMobile) && (
          <button
            onClick={() => setPreference(windowIsMobile ? "auto" : "mobile")}
            aria-label="切回手机视图"
            title="当前处于电脑视图，点击切回手机触控布局"
            className="flex h-7 items-center gap-1.5 rounded-btn px-2 text-caption font-medium transition text-teal border border-teal/40 bg-teal-tint/40 hover:bg-teal hover:text-white"
          >
            <Smartphone size={13} />
            <span className="hidden xs:inline">切回手机视图</span>
            <span className="xs:hidden">手机</span>
          </button>
        )}

        {/* 会话形态切换（结构化对话 | 终端 TUI）—— 最高优先级，任何宽度都在。
            面板收起时它是头部最右（pr-12 让出的对齐带里是右上浮层的重开钮）；
            面板展开时右侧是隔壁面板列。缩放全程零位移；手机顶栏同一组件也在
            右侧，跨版式阈值时位置与外观都不变。挤压全由左侧身份卡按阶梯吸收 */}
        <ConversationViewSwitch />
      </div>
    </header>
  );
}

/* ------------------------------------------------------------- 工作区直达 */

/**
 * 工作区打开按钮 —— 单击直接在资源管理器中打开，不再经弹层二跳。
 * 路径放 title 里悬停可见；打开成功短暂打勾作为反馈（daemon 不可达时失败只进 console）。
 */
function OpenWorkspaceFolder({ path }: { path: string }) {
  const [opened, setOpened] = useState(false);

  return (
    <button
      onClick={() => {
        void openFolder({ path })
          .then(() => {
            setOpened(true);
            window.setTimeout(() => setOpened(false), 1500);
          })
          .catch((err: unknown) => console.error("[WorkspaceHeader] 打开文件夹失败:", err));
      }}
      aria-label="在资源管理器中打开单元文件夹"
      title={`单元路径：${path}
单击在资源管理器中打开`}
      className={cn(iconBtn, opened && "text-gain")}
    >
      {opened ? <Check size={14} className="text-gain" /> : <FolderOpen size={14} />}
    </button>
  );
}
