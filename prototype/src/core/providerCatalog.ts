/**
 * 内置模型供应商目录 —— 数据源自 pi（badlogic/pi-mono @ 6f75515）
 * packages/ai/src/providers/*.ts 的 createProvider 声明，脚本提取。
 *
 * keyEnv 是该供应商约定的 API key 环境变量名（留空密钥 = 使用环境认证）。
 * api 字段目前只有 openai-completions / anthropic-messages 两类 wire 协议
 * （pi 支持的 openai-responses 等接入真运行时时再补）。
 */

export type CatalogApi = "openai-completions" | "anthropic-messages";

export interface CatalogProvider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly api: CatalogApi;
  readonly keyEnv: string;
}

export const PROVIDER_CATALOG: readonly CatalogProvider[] = [
  { id: "amazon-bedrock", name: "Amazon Bedrock", baseUrl: "", api: "openai-completions", keyEnv: "AMAZON_BEDROCK_API_KEY" },
  { id: "ant-ling", name: "Ant Ling", baseUrl: "https://api.ant-ling.com/v1", api: "openai-completions", keyEnv: "ANT_LING_API_KEY" },
  { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", api: "openai-completions", keyEnv: "ANTHROPIC_API_KEY" },
  { id: "azure-openai-responses", name: "Azure OpenAI", baseUrl: "", api: "openai-completions", keyEnv: "AZURE_OPENAI_RESPONSES_API_KEY" },
  { id: "baseten", name: "Baseten", baseUrl: "https://inference.baseten.co/v1", api: "openai-completions", keyEnv: "BASETEN_API_KEY" },
  { id: "cerebras", name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", api: "openai-completions", keyEnv: "CEREBRAS_API_KEY" },
  { id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway", baseUrl: "", api: "openai-completions", keyEnv: "CLOUDFLARE_AI_GATEWAY_API_KEY" },
  { id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", baseUrl: "", api: "openai-completions", keyEnv: "CLOUDFLARE_WORKERS_AI_API_KEY" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", api: "openai-completions", keyEnv: "DEEPSEEK_API_KEY" },
  { id: "fireworks", name: "Fireworks", baseUrl: "https://api.fireworks.ai/inference", api: "openai-completions", keyEnv: "FIREWORKS_API_KEY" },
  { id: "github-copilot", name: "GitHub Copilot", baseUrl: "https://api.individual.githubcopilot.com", api: "openai-completions", keyEnv: "GITHUB_COPILOT_API_KEY" },
  { id: "google-vertex", name: "Google Vertex AI", baseUrl: "", api: "openai-completions", keyEnv: "GOOGLE_VERTEX_API_KEY" },
  { id: "google", name: "Google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "openai-completions", keyEnv: "GOOGLE_API_KEY" },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions", keyEnv: "GROQ_API_KEY" },
  { id: "huggingface", name: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", api: "openai-completions", keyEnv: "HUGGINGFACE_API_KEY" },
  { id: "kimi-coding", name: "Kimi For Coding", baseUrl: "https://api.kimi.com/coding", api: "openai-completions", keyEnv: "KIMI_CODING_API_KEY" },
  { id: "meta", name: "Meta", baseUrl: "https://api.meta.ai/v1", api: "openai-completions", keyEnv: "META_API_KEY" },
  { id: "minimax-cn", name: "MiniMax CN", baseUrl: "https://api.minimaxi.com/anthropic", api: "anthropic-messages", keyEnv: "MINIMAX_CN_API_KEY" },
  { id: "minimax", name: "MiniMax", baseUrl: "https://api.minimax.io/anthropic", api: "anthropic-messages", keyEnv: "MINIMAX_API_KEY" },
  { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai", api: "openai-completions", keyEnv: "MISTRAL_API_KEY" },
  { id: "moonshotai-cn", name: "Moonshot AI CN", baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions", keyEnv: "MOONSHOTAI_CN_API_KEY" },
  { id: "moonshotai", name: "Moonshot AI", baseUrl: "https://api.moonshot.ai/v1", api: "openai-completions", keyEnv: "MOONSHOTAI_API_KEY" },
  { id: "nvidia", name: "NVIDIA", baseUrl: "https://integrate.api.nvidia.com/v1", api: "openai-completions", keyEnv: "NVIDIA_API_KEY" },
  { id: "openai-codex", name: "OpenAI Codex", baseUrl: "https://chatgpt.com/backend-api", api: "openai-completions", keyEnv: "OPENAI_CODEX_API_KEY" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai-completions", keyEnv: "OPENAI_API_KEY" },
  { id: "opencode-go", name: "OpenCode Go", baseUrl: "", api: "openai-completions", keyEnv: "OPENCODE_GO_API_KEY" },
  { id: "opencode", name: "OpenCode Zen", baseUrl: "", api: "openai-completions", keyEnv: "OPENCODE_API_KEY" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", keyEnv: "OPENROUTER_API_KEY" },
  { id: "qwen-token-plan-cn", name: "Qwen Token Plan CN", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", api: "openai-completions", keyEnv: "QWEN_TOKEN_PLAN_CN_API_KEY" },
  { id: "qwen-token-plan-individual", name: "Qwen Token Plan Individual", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", api: "openai-completions", keyEnv: "QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY" },
  { id: "qwen-token-plan", name: "Qwen Token Plan", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", api: "openai-completions", keyEnv: "QWEN_TOKEN_PLAN_API_KEY" },
  { id: "together", name: "Together", baseUrl: "https://api.together.ai/v1", api: "openai-completions", keyEnv: "TOGETHER_API_KEY" },
  { id: "typesafe", name: "TypeSafe", baseUrl: "", api: "openai-completions", keyEnv: "TYPESAFE_API_KEY" },
  { id: "vercel-ai-gateway", name: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh", api: "openai-completions", keyEnv: "VERCEL_AI_GATEWAY_API_KEY" },
  { id: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1", api: "openai-completions", keyEnv: "XAI_API_KEY" },
  { id: "xiaomi-token-plan-ams", name: "Xiaomi Token Plan AMS", baseUrl: "https://token-plan-ams.xiaomimimo.com/v1", api: "openai-completions", keyEnv: "XIAOMI_TOKEN_PLAN_AMS_API_KEY" },
  { id: "xiaomi-token-plan-cn", name: "Xiaomi Token Plan CN", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", api: "openai-completions", keyEnv: "XIAOMI_TOKEN_PLAN_CN_API_KEY" },
  { id: "xiaomi-token-plan-sgp", name: "Xiaomi Token Plan SGP", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", api: "openai-completions", keyEnv: "XIAOMI_TOKEN_PLAN_SGP_API_KEY" },
  { id: "xiaomi", name: "Xiaomi", baseUrl: "https://api.xiaomimimo.com/v1", api: "openai-completions", keyEnv: "XIAOMI_API_KEY" },
  { id: "zai-coding-cn", name: "Z.AI Coding CN", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", api: "openai-completions", keyEnv: "ZAI_CODING_CN_API_KEY" },
  { id: "zai", name: "Z.AI", baseUrl: "https://api.z.ai/api/coding/paas/v4", api: "openai-completions", keyEnv: "ZAI_API_KEY" },
];

export const CATALOG_BY_ID = new Map(PROVIDER_CATALOG.map((p) => [p.id, p]));
