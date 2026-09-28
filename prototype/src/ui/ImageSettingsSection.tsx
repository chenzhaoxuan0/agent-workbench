import { useEffect, useRef, useState } from "react";
import { ChevronDown, FolderOpen, ImagePlus, Trash2 } from "lucide-react";
import {
  IMAGE_STUDIO_STORAGE_KEY,
  PRESET_MODELS,
  useImageStudio,
} from "../store/useImageStudio.ts";
import type { ApiMode, ImageProfile, ReasoningEffort } from "../core/imageApi.ts";
import { clearSaveFolder, pickSaveFolder, SAVE_DIR_SUPPORT } from "../core/imageSave.ts";
import { cn } from "./cn.ts";

/**
 * 出图分区 —— 供应商 profile 管理（对齐 gpt_image_playground 的
 * SettingsModal / CustomProviderModal 的字段全集）。
 *
 * 结构沿用本设置页的 T3 Providers 习惯：上方 profile 行列表
 * （单选编辑 + 启用 Switch + 删除），下方是选中 profile 的完整编辑面。
 * 字段全集：名称 / API 地址 / Key / 接入模式（images|responses）/
 * 模型 / 图像模型（responses）/ 推理力度（responses）/ 超时 /
 * response_format=b64_json / Codex CLI 中转 / 流式 + partial images /
 * 透明背景实现方式。
 */

const API_MODE_LABEL: Record<ApiMode, string> = {
  images: "Images API",
  responses: "Responses API",
};

const EFFORT_OPTIONS: readonly (ReasoningEffort | "default")[] = ["default", "minimal", "low", "medium", "high"];

export function ImageSettingsSection() {
  const profiles = useImageStudio((s) => s.profiles);
  const activeProfileId = useImageStudio((s) => s.activeProfileId);
  const setActiveProfile = useImageStudio((s) => s.setActiveProfile);
  const addProfile = useImageStudio((s) => s.addProfile);
  const removeProfile = useImageStudio((s) => s.removeProfile);

  const [editingId, setEditingId] = useState<string>(activeProfileId);
  // 新增的 profile 自动成为编辑目标；被删的目标回退到第一个
  const prevLen = useRef(profiles.length);
  useEffect(() => {
    if (profiles.length > prevLen.current) {
      setEditingId(useImageStudio.getState().activeProfileId);
    } else if (!profiles.some((p) => p.id === editingId)) {
      setEditingId(profiles[0]!.id);
    }
    prevLen.current = profiles.length;
  }, [profiles, editingId]);

  const editing = profiles.find((p) => p.id === editingId) ?? profiles[0]!;
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {/* profile 行列表 */}
      <div className="rounded-card border border-line bg-card">
        <div className="flex items-center gap-2 px-4 py-3">
          <ImagePlus size={13} className="shrink-0 text-teal" />
          <p className="text-body-sm font-medium text-ink">图像供应商</p>
          <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">
            gpt_image_playground 字段全集
          </span>
          <button
            onClick={addProfile}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-btn border border-line px-2.5 py-1.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
          >
            <ImagePlus size={11} />
            添加供应商
          </button>
        </div>
        <div className="border-t border-line-soft">
          {profiles.map((p) => {
            const selected = p.id === editing.id;
            const active = p.id === activeProfileId;
            const confirming = confirmDeleteId === p.id;
            return (
              <div
                key={p.id}
                className={cn(
                  "flex items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-b-0",
                  selected && "bg-teal-tint/40",
                )}
              >
                <button
                  onClick={() => setEditingId(p.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", active ? "bg-teal" : "bg-line")} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-sm text-ink">
                      {p.name}
                      {active && (
                        <span className="ml-2 rounded-chip bg-teal-tint px-1.5 py-px text-[10px] text-teal">生效中</span>
                      )}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-ash">
                      {API_MODE_LABEL[p.apiMode]} · {p.model} · {hostOf(p.baseUrl)}
                    </span>
                  </span>
                </button>
                {/* 生效开关（Switch 语义） */}
                <button
                  onClick={() => setActiveProfile(p.id)}
                  role="switch"
                  aria-checked={active}
                  aria-label={`设为生效供应商：${p.name}`}
                  className={cn(
                    "relative h-4.5 w-8 shrink-0 rounded-full transition",
                    active ? "bg-teal" : "bg-line",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-canvas shadow-subtle transition-all",
                      active ? "left-[16px]" : "left-0.5",
                    )}
                  />
                </button>
                {profiles.length > 1 && (
                  confirming ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => {
                          removeProfile(p.id);
                          setConfirmDeleteId(null);
                        }}
                        className="rounded-chip bg-loss/10 px-2 py-0.5 text-[10px] text-loss hover:bg-loss/20"
                      >
                        确认删除
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-chip bg-line-soft px-2 py-0.5 text-[10px] text-graphite"
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(p.id)}
                      aria-label={`删除供应商 ${p.name}`}
                      className="shrink-0 rounded-btn p-1.5 text-ash hover:bg-line-soft hover:text-loss"
                    >
                      <Trash2 size={12} />
                    </button>
                  )
                )}
              </div>
            );
          })}
        </div>
        <p className="px-4 py-2 text-[10px] text-ash">
          配置与历史落 localStorage 键 <code className="font-mono">{IMAGE_STUDIO_STORAGE_KEY}</code>；
          直连 OpenAI 兼容端点（浏览器直连，端点需允许 CORS）。
        </p>
      </div>

      {/* 选中 profile 的完整编辑面 */}
      <ProfileEditor profile={editing} onChange={(patch) => useImageStudio.getState().updateProfile(editing.id, patch)} />

      {/* 保存位置（File System Access API，句柄存 IndexedDB） */}
      <SaveDirCard />
    </div>
  );
}

/* ------------------------------------------------------------- 保存位置 */

function SaveDirCard() {
  const saveDirName = useImageStudio((s) => s.saveDirName);
  const savePermission = useImageStudio((s) => s.savePermission);
  const autoSave = useImageStudio((s) => s.autoSave);
  const bindSaveDir = useImageStudio((s) => s.bindSaveDir);
  const unbindSaveDir = useImageStudio((s) => s.unbindSaveDir);
  const setAutoSave = useImageStudio((s) => s.setAutoSave);

  const supported = SAVE_DIR_SUPPORT;
  const [busy, setBusy] = useState(false);

  const onPick = async () => {
    setBusy(true);
    try {
      const name = await pickSaveFolder();
      if (name) bindSaveDir(name);
    } catch {
      /* 用户取消选择 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-card border border-line bg-card">
      <div className="flex items-center gap-2 px-4 py-3">
        <FolderOpen size={13} className="shrink-0 text-teal" />
        <p className="text-body-sm font-medium text-ink">保存位置</p>
        {saveDirName ? (
          <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 font-mono text-[10px] text-teal">{saveDirName}</span>
        ) : (
          <span className="rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-ash">未设置（仅存浏览器内）</span>
        )}
      </div>
      <div className="space-y-3 border-t border-line-soft px-4 py-3">
        {!supported && (
          <p className="text-[10px] leading-relaxed text-ash">
            当前浏览器不支持文件夹选择（File System Access 需要 Chromium 内核）。未设置时图片只存在浏览器内，「下载」按钮走浏览器默认下载目录。
          </p>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={() => void onPick()}
            disabled={!supported || busy}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-btn border border-line px-2.5 py-1.5 text-caption text-graphite",
              supported && !busy ? "hover:bg-line-soft hover:text-ink" : "cursor-not-allowed opacity-50",
            )}
          >
            <FolderOpen size={11} />
            {saveDirName ? "更换文件夹" : "选择文件夹"}
          </button>
          {saveDirName && (
            <button
              onClick={() => void clearSaveFolder().then(unbindSaveDir)}
              className="shrink-0 rounded-btn px-2.5 py-1.5 text-caption text-graphite hover:bg-line-soft hover:text-loss"
            >
              解除绑定
            </button>
          )}
          {saveDirName && savePermission === "prompt" && (
            <span className="rounded-chip bg-loss/10 px-2 py-0.5 text-[10px] text-loss">
              刷新后需重新授权（到出图工作台点一次「重新授权」）
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <ToggleSwitch checked={autoSave} onChange={setAutoSave} ariaLabel="image-autoSave" />
          <span className="text-caption text-graphite">生成成功后自动保存到该文件夹</span>
        </div>
        <p className="text-[10px] leading-relaxed text-ash">
          句柄保存在 IndexedDB（agent-workbench:image-fs），文件名格式
          <code className="font-mono"> img-&lt;时间&gt;-&lt;序号&gt;-&lt;prompt 短语&gt;.&lt;格式&gt;</code>
          ；页面刷新后浏览器要求对文件夹重新授权一次。
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 编辑面 */

function ProfileEditor({
  profile,
  onChange,
}: {
  profile: ImageProfile;
  onChange: (patch: Partial<ImageProfile>) => void;
}) {
  const isResponses = profile.apiMode === "responses";
  const isGptImage = profile.model.toLowerCase().includes("gpt-image");

  return (
    <div className="rounded-card border border-line bg-card">
      <div className="flex items-center gap-2 px-4 py-3">
        <p className="text-body-sm font-medium text-ink">编辑 · {profile.name}</p>
        <span className="rounded-chip bg-line-soft px-1.5 py-0.5 font-mono text-[10px] text-graphite">{profile.id}</span>
      </div>

      <div className="space-y-3 border-t border-line-soft px-4 py-3">
        <Row label="名称">
          <input
            value={profile.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className={INPUT_CLS}
          />
        </Row>
        <Row label="API 地址">
          <input
            value={profile.baseUrl}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
            className={cn(INPUT_CLS, "font-mono")}
          />
        </Row>
        <Row label="API Key">
          <input
            type="password"
            value={profile.apiKey}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            placeholder="sk-…（仅存本地）"
            className={cn(INPUT_CLS, "font-mono")}
          />
        </Row>
        <Row label="接入模式">
          <Segmented
            value={profile.apiMode}
            options={(["images", "responses"] as const).map((m) => ({ value: m, label: API_MODE_LABEL[m] }))}
            onChange={(apiMode) => onChange({ apiMode: apiMode as ApiMode })}
          />
          <p className="mt-1 text-[10px] leading-relaxed text-ash">
            {isResponses
              ? "走 /v1/responses：模型出 image_generation 工具调用，可配推理力度与专职图像模型"
              : "走 /v1/images/generations（生图）与 /v1/images/edits（参考图改图）"}
          </p>
        </Row>
        <Row label="模型">
          <input
            value={profile.model}
            onChange={(e) => onChange({ model: e.target.value })}
            className={cn(INPUT_CLS, "font-mono")}
          />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {PRESET_MODELS.map((m) => (
              <button
                key={m}
                onClick={() => onChange({ model: m })}
                className={cn(
                  "rounded-chip px-2 py-0.5 font-mono text-[10px]",
                  profile.model === m ? "bg-teal-tint text-ink" : "bg-line-soft text-graphite hover:text-ink",
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </Row>
        {isResponses && (
          <>
            <Row label="图像模型">
              <input
                value={profile.imageGenerationModel ?? ""}
                onChange={(e) => onChange({ imageGenerationModel: e.target.value || undefined })}
                placeholder="留空 = 跟随工具默认（如 gpt-image-2）"
                className={cn(INPUT_CLS, "font-mono")}
              />
            </Row>
            <Row label="推理力度">
              <Segmented
                value={profile.reasoningEffort ?? "default"}
                options={EFFORT_OPTIONS.map((e) => ({ value: e, label: e === "default" ? "默认" : e }))}
                onChange={(v) => onChange({ reasoningEffort: v === "default" ? undefined : (v as ReasoningEffort) })}
              />
            </Row>
          </>
        )}
        <Row label="超时（秒）">
          <input
            type="number"
            min={1}
            value={profile.timeout}
            onChange={(e) => onChange({ timeout: Math.max(1, Number(e.target.value) || 600) })}
            className={cn(INPUT_CLS, "w-28 tnum")}
          />
        </Row>
        <Row label="response_format=b64_json">
          <ToggleSwitch
            checked={Boolean(profile.responseFormatB64Json)}
            onChange={(v) => onChange({ responseFormatB64Json: v })}
            ariaLabel="profile-responseFormatB64Json"
          />
          <p className="mt-1 text-[10px] text-ash">dall-e 族需要；gpt-image 恒返回 b64，不要开。</p>
        </Row>
        <Row label="Codex CLI 中转">
          <ToggleSwitch checked={profile.codexCli} onChange={(v) => onChange({ codexCli: v })} ariaLabel="profile-codexCli" />
          <p className="mt-1 text-[10px] leading-relaxed text-ash">
            中转不支持 size/quality 参数：请求丢弃这两个字段，尺寸改写成 prompt 前缀
            （Generate at W×H resolution.），多张拆并发单发。
          </p>
        </Row>
        <Row label="流式传输">
          <ToggleSwitch checked={Boolean(profile.streamImages)} onChange={(v) => onChange({ streamImages: v })} ariaLabel="profile-streamImages" />
          {profile.streamImages && (
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-[10px] text-ash">partial images</span>
              <Stepper
                value={profile.streamPartialImages ?? 0}
                min={0}
                max={3}
                onChange={(v) => onChange({ streamPartialImages: v })}
              />
              <span className="text-[10px] text-ash">0–3 张过渡图，工作台内实时显示</span>
            </div>
          )}
        </Row>
        <Row label="透明背景实现">
          <Segmented
            value={profile.transparentBackgroundMethod}
            options={[
              { value: "api", label: "原生参数（api）" },
              { value: "local", label: "本地后处理（local）" },
            ]}
            onChange={(v) => onChange({ transparentBackgroundMethod: v as ImageProfile["transparentBackgroundMethod"] })}
          />
          <p className="mt-1 text-[10px] leading-relaxed text-ash">
            api：gpt-image 原生 background=transparent；local：canvas 抠图后处理（待接真实现，当前等效 api）。
          </p>
        </Row>
        {!isGptImage && !profile.codexCli && (
          <p className="text-[10px] leading-relaxed text-ash">
            非 gpt-image 模型：参数形态按 dall-e 族下发（尺寸族与 quality 取值不同，需要 response_format=b64_json）。
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 小件 */

const INPUT_CLS =
  "w-full rounded-btn border border-line bg-canvas px-2 py-1.5 text-caption text-ink outline-none focus:border-teal-edge";

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl || "—";
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[152px_1fr] items-start gap-2">
      <label className="pt-1.5 text-caption text-graphite">{label}</label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex w-fit shrink-0 items-center rounded-chip bg-line-soft p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-chip px-2.5 py-1 text-caption",
            o.value === value ? "bg-canvas font-medium text-ink" : "text-graphite hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={cn("relative h-4.5 w-8 rounded-full transition", checked ? "bg-teal" : "bg-line")}
    >
      <span
        className={cn(
          "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-canvas shadow-subtle transition-all",
          checked ? "left-[16px]" : "left-0.5",
        )}
      />
    </button>
  );
}

function Stepper({
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
    <span className="flex items-center rounded-btn border border-line">
      <button onClick={() => onChange(Math.max(min, value - 1))} className="px-1.5 py-0.5 text-caption text-graphite hover:text-ink" aria-label="减少">
        −
      </button>
      <span className="tnum min-w-6 text-center text-caption text-ink">{value}</span>
      <button onClick={() => onChange(Math.min(max, value + 1))} className="px-1.5 py-0.5 text-caption text-graphite hover:text-ink" aria-label="增加">
        +
      </button>
    </span>
  );
}
