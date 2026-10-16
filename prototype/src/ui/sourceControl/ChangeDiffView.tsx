import { FileWarning } from "lucide-react";

/**
 * 单文件 patch 视图（提交对话框与源代码管理页的「改动」区共用）。
 *
 * 只做「看得懂」，不上语法高亮：一个新增/删除前缀 + 等宽字号足够把改动
 * 讲清楚，而高亮会把 diff 行的首字符吃掉（`+`/`-` 与高亮色打架）。
 * binary / 空 patch 给一句话说明，不显示一屏原始提示。
 */
export function ChangeDiffView(props: {
  patch: string;
  binary: boolean;
  truncated: boolean;
  loading: boolean;
}) {
  if (props.loading) {
    return <div className="px-3 py-2 text-caption text-ash">读取 diff…</div>;
  }
  if (props.binary) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 text-caption text-ash">
        <FileWarning size={12} className="shrink-0" />
        二进制文件，没有可读的 diff
      </div>
    );
  }
  if (props.patch.trim().length === 0) {
    return <div className="px-3 py-2 text-caption text-ash">没有差异</div>;
  }
  return (
    <div className="overflow-x-auto">
      <pre className="m-0 px-3 py-2 font-mono text-[11px] leading-[1.55]">
        {props.patch.split("\n").map((line, i) => (
          <div key={i} className={diffLineClass(line)}>
            {line.length === 0 ? " " : line}
          </div>
        ))}
      </pre>
      {props.truncated && (
        <div className="border-t border-line-soft px-3 py-1.5 text-caption text-ash">
          diff 过长已截断 —— 完整内容请在编辑器里查看
        </div>
      )}
    </div>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-ash";
  if (line.startsWith("@@")) return "text-teal";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file")) return "text-ash";
  if (line.startsWith("+")) return "text-gain";
  if (line.startsWith("-")) return "text-loss";
  return "text-graphite";
}
