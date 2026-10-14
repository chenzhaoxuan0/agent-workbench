"""Antigravity SDK sidecar（docs/13 Phase 4 Tier 3）。

agent-workbench daemon 与 google-antigravity SDK 的桥：stdin/stdout 各走
NDJSON。协议（与 daemon 侧 agy.ts 约定）：
  daemon → sidecar：{"op":"config","apiKey":"...","model":"..."}   （首个 prompt 前可选）
                     {"op":"prompt","text":"..."}
                     {"op":"cancel"}
  sidecar → daemon：{"evt":"started","conversationId":"..."}
                     {"evt":"delta","kind":"text"|"thinking","text":"..."}
                     {"evt":"tool","toolName":"...","text":"..."}
                     {"evt":"completed","text":"<final>"}
                     {"evt":"error","message":"..."}

SDK 面（google-antigravity 0.1.x，examples/getting_started 实证）：
  Agent(LocalAgentConfig(api_key=...)) → agent.chat(prompt) → response
  async for token in response / response.thoughts / response.tool_calls
  persistence: LocalAgentConfig(save_dir=..., conversation_id=...) 跨进程 resume
"""

import asyncio
import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def main():
    from google.antigravity import Agent, LocalAgentConfig

    config_kwargs = {}
    agent = None

    def build_agent():
        nonlocal agent
        if agent is None:
            cfg = LocalAgentConfig(**config_kwargs)
            agent = Agent(config=cfg)
        return agent

    async def run_prompt(text):
        ag = build_agent()
        response = await ag.chat(text)
        final_parts = []
        async for token in response:
            if token:
                emit({"evt": "delta", "kind": "text", "text": str(token)})
                final_parts.append(str(token))
        try:
            async for thought in response.thoughts:
                if thought:
                    emit({"evt": "delta", "kind": "thinking", "text": str(thought)})
        except Exception:
            pass
        try:
            async for call in response.tool_calls:
                emit({
                    "evt": "tool",
                    "toolName": getattr(call, "name", "tool"),
                    "text": str(getattr(call, "input", ""))[:400],
                })
        except Exception:
            pass
        conversation_id = getattr(ag, "conversation_id", None)
        if conversation_id:
            emit({"evt": "started", "conversationId": str(conversation_id)})
        emit({"evt": "completed", "text": "".join(final_parts)})

    loop = asyncio.get_event_loop()
    pending_task = None

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        op = msg.get("op")
        if op == "config":
            if msg.get("apiKey"):
                config_kwargs["api_key"] = msg["apiKey"]
            if msg.get("saveDir"):
                config_kwargs["save_dir"] = msg["saveDir"]
            if msg.get("conversationId"):
                config_kwargs["conversation_id"] = msg["conversationId"]
        elif op == "prompt":
            if pending_task is not None:
                pending_task.cancel()
            pending_task = loop.create_task(run_prompt(msg.get("text", "")))
        elif op == "cancel":
            if pending_task is not None:
                pending_task.cancel()
                pending_task = None
                emit({"evt": "completed", "text": ""})
    # stdin EOF：等在途回合结束后退出
    if pending_task is not None:
        try:
            await pending_task
        except Exception:
            pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:  # noqa: BLE001 — 桥进程任何异常都要向 daemon 交代
        emit({"evt": "error", "message": str(exc)})
