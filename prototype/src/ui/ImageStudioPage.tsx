import { useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  Download,
  ImagePlus,
  Loader2,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  FORMAT_OPTIONS,
  PRESET_MODELS,
  IMAGE_STUDIO_STORAGE_KEY,
  qualityOptionsFor,
  sizeOptionsFor,
  useImageStudio,
  type ImageTask,
} from "../store/useImageStudio.ts";
import { useShell } from "../store/useShell.ts";
import { cn } from "./cn.ts";

/**
 * 出图工作台 —— 主视图（侧栏顶部动作区第三入口，与新建任务/搜索/自动化同级）。
 *
 * 生成逻辑移植自 gpt_image_playground（OpenAI 兼容 images API）：
 * - 纯文本 prompt → /v1/images/generations；
 * - 附参考图 → /v1/images/edits（FormData，image[] 多图）；
 * - 尺寸/质量选项随模型族切换（gpt-image* vs dall-e-3/2）；
 * - 历史任务本地留存（配额满丢最旧任务的图）。
 */

export function ImageStudioPage() {
  const setMainView = useShell((s) => s.setMainView);
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      {/* 面包屑顶带 —— 与自动化页同构（h-12 顶带吸顶） */}
      <div className="sticky top-0 z-10 border-b border-line bg-canvas">
        <div className="mx-auto flex h-12 max-w-4xl items-center gap-2 px-8">
          <button
            onClick={() => setMainView("chat")}
            className="flex items-center gap-1 rounded-btn px-2 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
          >
            <ChevronLeft size={12} />
            返回工作台
          </button>
          <span className="text-body-sm font-medium text-ink">出图</span>
          <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">OpenAI 兼容 images API</span>
          <span className="ml-auto font-mono text-[10px] text-ash">{IMAGE_STUDIO_STORAGE_KEY}</span>
        </div>
      </div>

      <div className="mx-auto max-w-4xl px-8 py-5">
        <Composer />
        <Gallery />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 输入区 */

function Composer() {
  const prompt = useImageStudio((s) => s.prompt);
  const setPrompt = useImageStudio((s) => s.setPrompt);
  const params = useImageStudio((s) => s.params);
  const setParams = useImageStudio((s) => s.setParams);
  const profile = useImageStudio((s) => s.profile);
  const refImages = useImageStudio((s) => s.refImages);
  const addRefImages = useImageStudio((s) => s.addRefImages);
  const removeRefImage = useImageStudio((s) => s.removeRefImage);
  const generate = useImageStudio((s) => s.generate);
  const busy = useImageStudio((s) => s.busy);

  const [configOpen, setConfigOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const missing = !profile.apiKey.trim();
  const canGenerate = !busy && prompt.trim().length > 0 && !missing;

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const dataUrls = await Promise.all(
      [...files].slice(0, 4).filter((f) => f.type.startsWith("image/")).map(fileToDataUrl),
    );
    addRefImages(dataUrls);
  };

  const sizes = sizeOptionsFor(profile.model);
  const qualities = qualityOptionsFor(profile.model);

  return (
    <section className="mb-6 rounded-card border border-line bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles size={13} className="shrink-0 text-teal" />
        <p className="text-body-sm font-medium text-ink">生成设置</p>
        <span className="text-[10px] text-ash">
          {refImages.length > 0 ? `参考图 ×${refImages.length} → 走 /images/edits 改图` : "纯文本 → /images/generations"}
        </span>
        <button
          onClick={() => setConfigOpen((o) => !o)}
          aria-expanded={configOpen}
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1 rounded-btn px-2 py-1 text-caption",
            configOpen ? "bg-teal-tint text-ink" : "text-graphite hover:bg-line-soft hover:text-ink",
          )}
        >
          <Settings2 size={12} />
          供应商
          <ChevronDown size={11} className={cn("transition-transform", configOpen && "rotate-180")} />
        </button>
      </div>

      {configOpen && <ProfileEditor />}

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canGenerate) void generate();
        }}
        placeholder="描述要生成的图片…（⌘Enter 生成）"
        rows={3}
        className="w-full resize-none rounded-input border border-line bg-rail px-3 py-2.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal-edge"
      />

      {refImages.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {refImages.map((src, i) => (
            <div key={`${i}-${src.slice(-16)}`} className="group relative">
              <img src={src} alt={`参考图 ${i + 1}`} className="h-16 w-16 rounded-btn border border-line object-cover" />
              <button
                onClick={() => removeRefImage(i)}
                aria-label={`移除参考图 ${i + 1}`}
                className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-line bg-canvas text-graphite shadow-subtle hover:text-loss"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* 参数组：尺寸/质量随模型族切换 */}
        <SelectChip label="尺寸" value={params.size} options={sizes} onChange={(size) => setParams({ size })} />
        <SelectChip label="质量" value={params.quality} options={qualities} onChange={(quality) => setParams({ quality })} />
        {profile.model.toLowerCase().includes("gpt-image") && (
          <SelectChip
            label="格式"
            value={params.output_format}
            options={[...FORMAT_OPTIONS]}
            labels={{ png: "PNG", jpeg: "JPEG", webp: "WebP" }}
            onChange={(v) => setParams({ output_format: v as (typeof FORMAT_OPTIONS)[number] })}
          />
        )}
        <StepperChip value={params.n} min={1} max={4} onChange={(n) => setParams({ n })} />

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void onFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="flex shrink-0 items-center gap-1 rounded-btn border border-line px-2.5 py-1.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
        >
          <ImagePlus size={12} />
          参考图
        </button>

        <button
          onClick={() => void generate()}
          disabled={!canGenerate}
          title={missing ? "先在「供应商」里填 API Key" : undefined}
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1.5 rounded-btn bg-ink px-4 py-1.5 text-caption font-medium text-canvas",
            canGenerate ? "hover:bg-graphite" : "cursor-not-allowed opacity-50",
          )}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {busy ? "生成中…" : "生成"}
        </button>
      </div>
    </section>
  );
}

function ProfileEditor() {
  const profile = useImageStudio((s) => s.profile);
  const setProfile = useImageStudio((s) => s.setProfile);
  return (
    <div className="mb-3 space-y-2 rounded-input border border-line-soft bg-rail p-3">
      <div className="grid grid-cols-[92px_1fr] items-center gap-2">
        <label className="text-caption text-graphite" htmlFor="studio-baseurl">API 地址</label>
        <input
          id="studio-baseurl"
          value={profile.baseUrl}
          onChange={(e) => setProfile({ baseUrl: e.target.value })}
          placeholder="https://api.openai.com/v1"
          className="rounded-btn border border-line bg-canvas px-2 py-1 font-mono text-caption text-ink outline-none focus:border-teal-edge"
        />
        <label className="text-caption text-graphite" htmlFor="studio-key">API Key</label>
        <input
          id="studio-key"
          type="password"
          value={profile.apiKey}
          onChange={(e) => setProfile({ apiKey: e.target.value })}
          placeholder="sk-…（仅存本地 localStorage）"
          className="rounded-btn border border-line bg-canvas px-2 py-1 font-mono text-caption text-ink outline-none focus:border-teal-edge"
        />
        <label className="text-caption text-graphite" htmlFor="studio-model">模型</label>
        <div className="flex items-center gap-1.5">
          <input
            id="studio-model"
            value={profile.model}
            onChange={(e) => setProfile({ model: e.target.value })}
            className="min-w-0 flex-1 rounded-btn border border-line bg-canvas px-2 py-1 font-mono text-caption text-ink outline-none focus:border-teal-edge"
          />
          {[...PRESET_MODELS].map((m) => (
            <button
              key={m}
              onClick={() => setProfile({ model: m })}
              className={cn(
                "shrink-0 rounded-chip px-2 py-0.5 text-[10px]",
                profile.model === m ? "bg-teal-tint text-ink" : "bg-line-soft text-graphite hover:text-ink",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[10px] leading-relaxed text-ash">
        逻辑移植自 gpt_image_playground：直连 OpenAI 兼容端点（浏览器直连，需端点允许 CORS）；
        模型族决定参数形态 —— gpt-image* 走 size/quality/output_format，dall-e 走 response_format=b64_json。
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- 结果画廊 */

function Gallery() {
  const history = useImageStudio((s) => s.history);
  const removeTask = useImageStudio((s) => s.removeTask);
  const clearHistory = useImageStudio((s) => s.clearHistory);

  if (history.length === 0) {
    return (
      <p className="py-14 text-center text-body-sm text-ash">
        还没有生成记录。填好 API Key，写一段描述，生成第一张图。
      </p>
    );
  }
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 px-1">
        <p className="text-caption text-ash">
          生成记录 · {history.length} 条（本地留存，配额满时丢最旧任务的图）
        </p>
        <button
          onClick={clearHistory}
          className="ml-auto flex items-center gap-1 rounded-btn px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-loss"
        >
          <Trash2 size={11} />
          清空
        </button>
      </div>
      <div className="space-y-3">
        {history.map((t) => (
          <TaskCard key={t.id} t={t} onRemove={() => removeTask(t.id)} />
        ))}
      </div>
    </div>
  );
}

function TaskCard({ t, onRemove }: { t: ImageTask; onRemove: () => void }) {
  const time = useMemo(
    () => new Date(t.ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
    [t.ts],
  );
  return (
    <div className="rounded-card border border-line bg-card px-4 py-3">
      <div className="flex items-baseline gap-2">
        <p className="min-w-0 flex-1 truncate text-body-sm text-ink">{t.prompt}</p>
        <span className="tnum shrink-0 text-[10px] text-ash">{time}</span>
        <button
          onClick={onRemove}
          aria-label="删除该条记录"
          className="shrink-0 rounded-btn p-1 text-ash hover:bg-line-soft hover:text-loss"
        >
          <Trash2 size={11} />
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="rounded-chip bg-line-soft px-1.5 py-0.5 font-mono text-[10px] text-graphite">{t.params.size}</span>
        <span className="rounded-chip bg-line-soft px-1.5 py-0.5 font-mono text-[10px] text-graphite">{t.params.quality}</span>
        <span className="rounded-chip bg-line-soft px-1.5 py-0.5 font-mono text-[10px] text-graphite">×{t.params.n}</span>
        <span className="rounded-chip bg-line-soft px-1.5 py-0.5 font-mono text-[10px] text-graphite">{t.params.output_format}</span>
        {t.refImages && (
          <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">参考图 ×{t.refImages.length}</span>
        )}
      </div>

      {t.pending && (
        <p className="mt-3 flex items-center gap-2 text-caption text-graphite">
          <Loader2 size={12} className="animate-spin text-teal" />
          生成中…（gpt-image 一张约 20–60s）
        </p>
      )}
      {t.error && (
        <p className="mt-3 break-all rounded-btn bg-loss/5 px-2.5 py-2 text-caption leading-relaxed text-loss">{t.error}</p>
      )}
      {t.images.length > 0 && (
        <>
          {t.revisedPrompt && (
            <p className="mt-2 line-clamp-2 text-[10px] leading-relaxed text-ash" title={t.revisedPrompt}>
              revised: {t.revisedPrompt}
            </p>
          )}
          <div className={cn("mt-2 grid gap-2", t.images.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
            {t.images.map((src, i) => (
              <figure key={`${t.id}-${i}`} className="group relative overflow-hidden rounded-input border border-line">
                <img src={src} alt={`${t.prompt} 结果 ${i + 1}`} className="block w-full bg-line-soft object-contain" />
                <a
                  href={src}
                  download={`image-${t.id}-${i + 1}.png`}
                  className="absolute bottom-2 right-2 flex items-center gap-1 rounded-btn bg-canvas/90 px-2 py-1 text-[10px] text-ink opacity-0 shadow-subtle transition group-hover:opacity-100"
                >
                  <Download size={10} />
                  下载
                </a>
              </figure>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- 小件 */

function SelectChip({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  labels?: Record<string, string>;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-btn border border-line px-2.5 py-1.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
      >
        <span className="text-ash">{label}</span>
        {labels?.[value] ?? value}
        <ChevronDown size={11} />
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 top-full z-20 mt-1 min-w-[120px] overflow-hidden rounded-btn border border-line bg-canvas py-0.5 shadow-subtle">
            {options.map((o) => (
              <button
                key={o}
                onClick={() => {
                  onChange(o);
                  setOpen(false);
                }}
                className={cn(
                  "block w-full whitespace-nowrap px-3 py-1.5 text-left font-mono text-caption",
                  o === value ? "bg-teal-tint font-medium text-ink" : "text-graphite hover:bg-line-soft",
                )}
              >
                {labels?.[o] ?? o}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function StepperChip({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex shrink-0 items-center rounded-btn border border-line">
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        aria-label="减少张数"
        className="px-2 py-1.5 text-caption text-graphite hover:text-ink"
      >
        −
      </button>
      <span className="tnum min-w-8 text-center text-caption text-ink">{value} 张</span>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        aria-label="增加张数"
        className="px-2 py-1.5 text-caption text-graphite hover:text-ink"
      >
        +
      </button>
    </div>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}
