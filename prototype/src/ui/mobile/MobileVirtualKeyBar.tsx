import { useTerminalStore } from "../../store/useTerminalStore.ts";
import { terminalSessionRegistry } from "../../store/TerminalSessionManager.ts";

interface KeyDef {
  label: string;
  data: string;
  hint?: string;
  primary?: boolean;
}

const KEYS: KeyDef[] = [
  { label: "ESC", data: "\x1b", hint: "退出/取消" },
  { label: "TAB", data: "\t", hint: "自动补全" },
  { label: "Ctrl+C", data: "\x03", hint: "中断进程", primary: true },
  { label: "↑", data: "\x1b[A", hint: "历史上一条" },
  { label: "↓", data: "\x1b[B", hint: "历史下一条" },
  { label: "←", data: "\x1b[D", hint: "左移光标" },
  { label: "→", data: "\x1b[C", hint: "右移光标" },
  { label: "/", data: "/", hint: "斜杠命令" },
  { label: "CLEAR", data: "\x0c", hint: "清除终端屏幕" },
];

export function MobileVirtualKeyBar() {
  const activeInstanceId = useTerminalStore((s) => s.activeInstanceId);

  const handleKeyPress = (data: string) => {
    if (!activeInstanceId) return;
    const session = terminalSessionRegistry.get(activeInstanceId);
    if (session) {
      session.sendData(data);
    }
  };

  return (
    <div className="flex h-11 w-full shrink-0 items-center gap-1.5 overflow-x-auto border-t border-line/80 bg-rail px-2 py-1 select-none scrollbar-none">
      {KEYS.map((k) => (
        <button
          key={k.label}
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            handleKeyPress(k.data);
          }}
          title={k.hint}
          aria-label={`终端虚拟键 ${k.label} (${k.hint || ""})`}
          className="flex h-8 shrink-0 items-center justify-center rounded-lg border border-line bg-card px-3 text-caption font-mono font-medium text-ink shadow-xs transition active:scale-95 active:border-teal active:bg-teal active:text-white"
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
