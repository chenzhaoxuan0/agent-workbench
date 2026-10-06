import { useMemo, useState } from "react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { CATALOG_BY_ID, PROVIDER_CATALOG, type CatalogApi } from "../core/providerCatalog.ts";
import { useProviderProfiles, type ProviderApi, type ProviderProfile } from "../store/useProviderProfiles.ts";
import { cn } from "./cn.ts";

/**
 * 模型供应商管理 —— 对齐 dsh 的 ModelsSection + CustomProviderCard。
 *
 * 两个添加模式（SegmentedControl 切换，草稿互不丢失）：
 * - **第三方模型提供商**：从内置目录（pi providers，41 家）选一家，
 *   填 API 密钥即可（留空 = 使用环境认证）；
 * - **自定义模型 API**：中转站 / 自部署 / 兼容 OpenAI·Anthropic 协议的
 *   接口——Provider ID（小写连字符 + 查重）、显示名称、API 地址、协议、
 *   密钥、模型目录多行（窗口支持 256K / 1M 速记）。
 *
 * 行列表：名称 + 凭据状态点（实心已配 / 空心缺）+ Custom 标 + 编辑/删除。
 * 「打开配置文件」的原型等价物 = 底部配置预览折叠面板。
 */

const ROUTE_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const API_LABEL: Record<ProviderApi, string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};
const API_CHOICES: readonly ProviderApi[] = ["openai-completions", "openai-responses", "anthropic-messages"];

export function ProviderSettingsSection() {
  const profiles = useProviderProfiles((s) => s.profiles);
  const upsert = useProviderProfiles((s) => s.upsert);
  const remove = useProviderProfiles((s) => s.remove);

  const [mode, setMode] = useState<"catalog" | "custom" | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const rows = useMemo(() => Object.values(profiles).sort((a, b) => a.route.localeCompare(b.route)), [profiles]);
  const editingProfile = editing ? profiles[editing] : undefined;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-caption text-ash">
          填入各供应商的 API 密钥即可使用其模型。目录数据来自 pi（41 家），自定义接口走兼容协议。
        </p>
        {mode === null && !editing && (
          <button
            onClick={() => setMode("catalog")}
            className="flex shrink-0 items-center gap-1 rounded-btn bg-ink px-2.5 py-1.5 text-body-sm text-canvas hover:opacity-90 active:scale-95 transition"
          >
            <Plus size={11} />
            添加模型供应商
          </button>
        )}
      </div>

      {/* 行列表 */}
      <ul className="space-y-1.5">
        {rows.length === 0 && (
          <li className="rounded-card border border-dashed border-line px-4 py-4 text-center text-body-sm text-ash">
            还没有配置任何供应商 —— 点右上角「添加模型供应商」开始。
          </li>
        )}
        {rows.map((p) => {
          const hasKey = Boolean(p.apiKey);
          const isCustom = p.origin === "custom";
          const catalogName = p.catalogId ? CATALOG_BY_ID.get(p.catalogId)?.name : undefined;
          return (
            <li
              key={p.route}
              className={cn(
                "flex items-center gap-2.5 rounded-card border px-3.5 py-2.5",
                confirmDelete === p.route ? "border-loss" : "border-line",
              )}
            >
              <span
                className={cn("h-2 w-2 shrink-0 rounded-full", hasKey ? "bg-gain" : "border border-graphite bg-transparent")}
                title={hasKey ? "已配置密钥" : "未配置密钥（留空则使用环境认证）"}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate text-body-sm font-medium text-ink">
                    {p.displayName || catalogName || p.route}
                  </span>
                  <span className="tnum shrink-0 font-mono text-caption text-ash">{p.route}</span>
                  {isCustom && <span className="shrink-0 rounded-chip bg-teal-tint px-1.5 text-caption text-teal">Custom</span>}
                </span>
              </span>
              {confirmDelete === p.route ? (
                <>
                  <span className="text-caption text-loss">确认删除？</span>
                  <button
                    onClick={() => {
                      remove(p.route);
                      setConfirmDelete(null);
                    }}
                    className="rounded-btn border border-loss px-1.5 py-0.5 text-caption text-loss hover:bg-loss/10"
                  >
                    删除
                  </button>
                  <button
                    onClick={() => setConfirmDelete(null)}
                    className="rounded-btn px-1.5 py-0.5 text-caption text-graphite hover:bg-line-soft"
                  >
                    取消
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setEditing(p.route)}
                    className="shrink-0 rounded-btn border border-line px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => setConfirmDelete(p.route)}
                    aria-label={`删除 ${p.route}`}
                    title="删除"
                    className="shrink-0 rounded p-1 text-ash hover:bg-line-soft hover:text-loss"
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {/* 添加卡（双模式） */}
      {mode !== null && (
        <AddProviderCard
          mode={mode}
          onModeChange={setMode}
          onClose={() => setMode(null)}
          onCreate={(profile) => {
            upsert(profile);
            setMode(null);
          }}
        />
      )}

      {/* 编辑卡 */}
      {editingProfile && (
        <AddProviderCard
          // ⚠ key 必须有：卡片内部用 useState 初始化表单，换一个 provider 编辑时
          // 复用同一个实例就不会重置 —— 头部显示新选的、字段还是上一个的，
          // 保存时报出莫名其妙的「route 已存在」。
          key={editingProfile.route}
          mode={editingProfile.origin === "custom" ? "custom" : "catalog"}
          existing={editingProfile}
          onClose={() => setEditing(null)}
          onCreate={(profile) => {
            upsert(profile);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- 添加 / 编辑卡 */

function AddProviderCard({
  mode,
  onModeChange,
  onClose,
  onCreate,
  existing,
}: {
  mode: "catalog" | "custom";
  /** 仅添加卡（无 existing）会渲染模式切换；编辑卡传 undefined */
  onModeChange?: (m: "catalog" | "custom") => void;
  onClose: () => void;
  onCreate: (profile: ProviderProfile) => void;
  existing?: ProviderProfile;
}) {
  // catalog 模式状态
  const [catalogId, setCatalogId] = useState(existing?.catalogId ?? PROVIDER_CATALOG[0]!.id);
  const [apiKey, setApiKey] = useState(existing?.apiKey ?? "");
  const [customize, setCustomize] = useState(false);
  const [displayName, setDisplayName] = useState(existing?.displayName ?? "");
  const [baseUrlOverride, setBaseUrlOverride] = useState(existing?.baseUrl ?? "");

  // custom 模式状态
  const [route, setRoute] = useState(existing?.origin === "custom" ? existing.route : "");
  const [customName, setCustomName] = useState(existing?.origin === "custom" ? (existing.displayName ?? "") : "");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [api, setApi] = useState<ProviderApi>(existing?.api ?? "openai-completions");
  const [models, setModels] = useState<readonly DraftModel[]>(
    existing?.origin === "custom" && existing.models.length > 0
      ? existing.models.map((m) => ({
          id: m.id,
          name: m.name ?? "",
          ctx: m.contextWindow ? String(m.contextWindow) : "",
        }))
      : [emptyModel()],
  );
  const [errors, setErrors] = useState<string[]>([]);

  const catalog = CATALOG_BY_ID.get(catalogId);

  const submit = () => {
    const errs: string[] = [];
    let profile: ProviderProfile;

    if (mode === "catalog") {
      const entry = CATALOG_BY_ID.get(catalogId);
      if (!entry) return;
      profile = {
        route: catalogId,
        catalogId,
        origin: "catalog",
        displayName: displayName.trim() || undefined,
        api: entry.api,
        baseUrl: baseUrlOverride.trim() || entry.baseUrl,
        apiKey: apiKey.trim() || undefined,
        models: [],
      };
    } else {
      const routeId = route.trim();
      if (!ROUTE_RE.test(routeId)) errs.push("Provider ID 需以小写字母开头，只能含小写字母 / 数字 / 连字符");
      const taken = useProviderProfiles.getState().profiles[routeId] && existing?.route !== routeId;
      if (taken) errs.push(`route「${routeId}」已存在`);
      if (!/^https?:\/\//.test(baseUrl.trim())) errs.push("API 地址需以 http(s):// 开头");
      const modelRows = models.filter((m) => m.id.trim().length > 0);
      if (modelRows.length === 0) errs.push("至少添加一个模型（目录外 ID 仍可直接发送，但目录为空不利于选择）");
      const ids = new Set<string>();
      for (const m of modelRows) {
        if (ids.has(m.id.trim())) errs.push(`模型 id 重复：${m.id.trim()}`);
        ids.add(m.id.trim());
      }
      if (errs.length > 0) return setErrors(errs);
      profile = {
        route: routeId,
        origin: "custom",
        displayName: customName.trim() || undefined,
        api,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        models: modelRows.map((m) => ({
          id: m.id.trim(),
          name: m.name.trim() || undefined,
          contextWindow: parseCapacity(m.ctx),
        })),
      };
    }

    onCreate(profile);
  };

  return (
    <div className="rounded-card border border-line bg-canvas">
      {/* 模式切换（dsh 的 SegmentedControl） */}
      {!existing && (
        <div className="flex items-center gap-1 border-b border-line px-3 py-2">
          <div className="flex items-center rounded-chip bg-line-soft p-0.5">
            {(["catalog", "custom"] as const).map((m) => (
              <button
                key={m}
                onClick={() => onModeChange?.(m)}
                aria-pressed={mode === m}
                className={cn(
                  "rounded-chip px-2.5 py-1 text-caption",
                  mode === m ? "bg-canvas font-medium text-ink" : "text-graphite hover:text-ink",
                )}
              >
                {m === "catalog" ? "第三方模型提供商" : "自定义模型 API"}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3 p-3.5">
        {mode === "catalog" ? (
          <>
            <p className="text-caption text-ash">从内置目录中选择 OpenAI、Anthropic、Kimi 等提供商，填入其 API 密钥即可使用。</p>
            <Field label="提供商">
              <div className="relative">
                <select
                  value={catalogId}
                  onChange={(e) => setCatalogId(e.target.value)}
                  aria-label="提供商"
                  className="w-72 appearance-none rounded-input border border-line bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none focus:border-teal"
                >
                  {PROVIDER_CATALOG.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id}
                    </option>
                  ))}
                </select>
                <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ash" />
              </div>
            </Field>
            <Field label="API 密钥" hint={catalog ? `留空则使用环境认证（${catalog.keyEnv}）` : undefined}>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="输入 API 密钥，或留空使用环境认证"
                className="w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal"
              />
            </Field>
            <details className="text-caption" onToggle={(e) => setCustomize((e.target as HTMLDetailsElement).open)}>
              <summary className="flex cursor-pointer items-center gap-1 text-graphite hover:text-ink">
                <ChevronDown size={11} className={cn("transition-transform", customize && "rotate-0", !customize && "-rotate-90")} />
                自定义设置
              </summary>
              <div className="mt-2 space-y-2">
                <Field label="显示名称（可选）">
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={catalog?.name ?? ""}
                    className="w-64 rounded-input bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal"
                  />
                </Field>
                <Field label="API 地址覆盖（可选）" hint={catalog?.baseUrl ? `默认：${catalog.baseUrl}` : undefined}>
                  <input
                    value={baseUrlOverride}
                    onChange={(e) => setBaseUrlOverride(e.target.value)}
                    placeholder={catalog?.baseUrl || "https://…"}
                    className="w-72 rounded-input bg-rail px-2.5 py-1.5 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
                  />
                </Field>
              </div>
            </details>
          </>
        ) : (
          <>
            <p className="text-caption leading-relaxed text-ash">
              连接中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口，需填写 API 地址、协议和模型。
            </p>
            <Field label="Provider ID" hint="以小写字母开头的标识，在请求中唯一标识该提供商，并用于派生凭据名。">
              <input
                value={route}
                onChange={(e) => setRoute(e.target.value)}
                placeholder="acme-gateway"
                spellCheck={false}
                className="w-full rounded-input bg-rail px-2.5 py-1.5 font-mono text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal"
              />
            </Field>
            <Field label="显示名称">
              <input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="显示名称"
                className="w-full rounded-input bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal"
              />
            </Field>
            <Field label="API 地址">
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://gateway.example/v1"
                spellCheck={false}
                className="w-full rounded-input bg-rail px-2.5 py-1.5 font-mono text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal"
              />
            </Field>
            <Field label="API 协议">
              <div className="relative w-64">
                <select
                  value={api}
                  onChange={(e) => setApi(e.target.value as ProviderApi)}
                  aria-label="API 协议"
                  className="w-full appearance-none rounded-input border border-line bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none focus:border-teal"
                >
                  {API_CHOICES.map((a) => (
                    <option key={a} value={a}>
                      {API_LABEL[a]}
                    </option>
                  ))}
                </select>
                <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ash" />
              </div>
            </Field>
            <Field label="API 密钥">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="输入 API 密钥"
                className="w-full rounded-input bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal"
              />
            </Field>
            <Field label="模型目录" hint="模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。">
              <span />
            </Field>
            <div className="space-y-1.5">
              {models.map((m, i) => (
                <div key={i} className="flex flex-wrap items-center gap-1.5">
                  <input
                    value={m.id}
                    onChange={(e) =>
                      setModels((ms) => ms.map((x, xi) => (xi === i ? { ...x, id: e.target.value } : x)))
                    }
                    placeholder="模型 id *"
                    aria-label={`模型 ${i + 1} id`}
                    spellCheck={false}
                    className="w-44 rounded-input bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
                  />
                  <input
                    value={m.name}
                    onChange={(e) =>
                      setModels((ms) => ms.map((x, xi) => (xi === i ? { ...x, name: e.target.value } : x)))
                    }
                    placeholder="显示名（可选）"
                    aria-label={`模型 ${i + 1} 显示名`}
                    className="w-36 rounded-input border border-transparent bg-rail px-2 py-1 text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
                  />
                  <input
                    value={m.ctx}
                    onChange={(e) =>
                      setModels((ms) => ms.map((x, xi) => (xi === i ? { ...x, ctx: e.target.value } : x)))
                    }
                    placeholder="窗口 256K"
                    aria-label={`模型 ${i + 1} 上下文窗口`}
                    className="w-24 rounded-input border border-transparent bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
                  />
                  {models.length > 1 && (
                    <button
                      onClick={() => setModels((ms) => ms.filter((_, xi) => xi !== i))}
                      aria-label={`移除模型 ${i + 1}`}
                      className="shrink-0 rounded p-0.5 text-ash hover:bg-line hover:text-loss"
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              ))}
              <button
                onClick={() => setModels((ms) => [...ms, { id: "", name: "", ctx: "" }])}
                className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
              >
                <Plus size={10} />
                添加模型
              </button>
            </div>
          </>
        )}

        {errors.length > 0 && (
          <ul className="space-y-0.5">
            {errors.map((e) => (
              <li key={e} className="text-caption text-loss">
                {e}
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-btn px-3 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink">
            取消
          </button>
          <button onClick={submit} className="rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas hover:opacity-90 active:scale-95 transition">
            {mode === "custom" && !existing ? "创建提供商" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 容量速记（dsh parseCapacity 同款） */
export function parseCapacity(raw: string): number | undefined {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)([km])?$/i);
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]!);
  const unit = m[2]?.toLowerCase();
  const mult = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
  return Math.round(n * mult);
}


/** 多行草稿的一行（dsh CustomProviderCard 的 models 数组形态） */
interface DraftModel {
  id: string;
  name: string;
  ctx: string;
}

const emptyModel = (): DraftModel => ({ id: "", name: "", ctx: "" });

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-caption font-medium text-graphite">{label}</span>
      {children}
      {hint && <span className="block text-caption text-ash">{hint}</span>}
    </label>
  );
}
