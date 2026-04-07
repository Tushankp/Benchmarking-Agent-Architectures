import asyncio
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
import sys
import time
from datetime import datetime
from typing import Any, Dict

import yaml
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agents.multi_agent import MultiAgentSystem
from agents.prompt_based import PromptBasedAgent
from agents.tool_augmented import ToolAugmentedAgent
from benchmark.evaluator import Evaluator
from utils.llm_client import LLMClient

load_dotenv()

with open("config.yaml", "r") as file_obj:
    config = yaml.safe_load(file_obj)

llm_client = LLMClient(
    {
        **config,
        "openai_api_key": os.getenv("OPENAI_API_KEY"),
        "ollama_base_url": os.getenv("OLLAMA_BASE_URL"),
    }
)

AGENTS = {
    "prompt_based": PromptBasedAgent(config, llm_client),
    "tool_augmented": ToolAugmentedAgent(config, llm_client),
    "multi_agent": MultiAgentSystem(config, llm_client),
}

app = Flask(__name__)
CORS(app)
evaluator = Evaluator()


def run_async(coro):
    """Run an async coroutine from a Flask request handler."""
    return asyncio.run(coro)


def build_task(data: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize request payload into the internal task format."""
    question = (data.get("question") or "").strip()
    task_type = (data.get("task_type") or "reasoning").strip().lower()

    return {
        "id": data.get("id") or f"user_{int(time.time())}",
        "task_type": task_type,
        "description": question,
        "code_snippet": data.get("code_snippet", ""),
        "context": data.get("context", ""),
        "cve_id": data.get("cve_id", ""),
        "target_description": data.get("target", ""),
        "goal": data.get("goal") or question,
    }


def validate_task(task: Dict[str, Any]) -> str | None:
    """Return an error string when the payload is incomplete."""
    if task["task_type"] not in {"reasoning", "retrieval", "planning"}:
        return "task_type must be one of: reasoning, retrieval, planning"

    if task["task_type"] == "retrieval" and not task["cve_id"] and not task["description"]:
        return "retrieval requests need a cve_id or question"

    if task["task_type"] == "planning" and not task["target_description"] and not task["goal"]:
        return "planning requests need a target or goal"

    if task["task_type"] == "reasoning" and not task["description"] and not task["code_snippet"]:
        return "reasoning requests need a question or code_snippet"

    return None


def serialize_result(result, task: Dict[str, Any], elapsed: float | None = None) -> Dict[str, Any]:
    """Convert AgentResult into JSON-safe output."""
    return {
        "task_id": result.task_id,
        "task_type": result.task_type,
        "architecture": result.architecture,
        "success": result.success,
        "exploit_code": result.exploit_code,
        "execution_time": elapsed if elapsed is not None else result.execution_time,
        "token_count": result.token_count,
        "metrics": evaluator.evaluate(result, task),
        "error": result.error_message,
        "steps": result.steps,
        "timestamp": result.timestamp.isoformat(),
    }


def execute_agent(agent_name: str, task: Dict[str, Any]) -> Dict[str, Any]:
    """Run one named agent and return serialized output."""
    agent = AGENTS.get(agent_name)
    if agent is None:
        raise KeyError(agent_name)

    start = time.time()
    result = run_async(agent.generate_exploit(task))
    elapsed = time.time() - start
    return serialize_result(result, task, elapsed)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify(
        {
            "status": "ok",
            "provider": llm_client.provider,
            "model": llm_client.model,
            "available_agents": list(AGENTS.keys()),
            "timestamp": datetime.now().isoformat(),
        }
    )


@app.route("/api/agents", methods=["GET"])
def list_agents():
    return jsonify(
        {
            "agents": [
                {
                    "id": agent_id,
                    "name": agent.get_architecture_name(),
                }
                for agent_id, agent in AGENTS.items()
            ],
            "provider": llm_client.provider,
            "model": llm_client.model,
        }
    )


@app.route("/api/agents/<agent_name>/generate", methods=["POST"])
def generate_with_agent(agent_name: str):
    data = request.get_json(silent=True) or {}
    task = build_task(data)
    validation_error = validate_task(task)

    if validation_error:
        return jsonify({"error": validation_error}), 400

    if agent_name not in AGENTS:
        return (
            jsonify(
                {
                    "error": f"Unknown agent '{agent_name}'",
                    "available_agents": list(AGENTS.keys()),
                }
            ),
            404,
        )

    try:
        result = execute_agent(agent_name, task)
    except Exception as exc:
        return jsonify({"error": str(exc), "agent": agent_name, "task": task}), 500

    return jsonify(
        {
            "agent": agent_name,
            "task": task,
            "result": result,
            "timestamp": datetime.now().isoformat(),
        }
    )


@app.route("/api/generate", methods=["POST"])
def generate_exploit():
    """Run all agents for a single task payload."""
    data = request.get_json(silent=True) or {}
    task = build_task(data)
    validation_error = validate_task(task)

    if validation_error:
        return jsonify({"error": validation_error}), 400

    results: Dict[str, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=len(AGENTS)) as executor:
        future_to_agent = {
            executor.submit(execute_agent, agent_name, task): agent_name for agent_name in AGENTS
        }
        for future in as_completed(future_to_agent):
            agent_name = future_to_agent[future]
            try:
                results[agent_name] = future.result()
            except Exception as exc:
                results[agent_name] = {
                    "success": False,
                    "exploit_code": None,
                    "execution_time": 0,
                    "token_count": 0,
                    "metrics": evaluator.empty_metrics(task, error=str(exc)),
                    "error": str(exc),
                    "steps": [],
                }

    ordered_results = {agent_name: results[agent_name] for agent_name in AGENTS}

    return jsonify(
        {
            "task": task,
            "results": ordered_results,
            "timestamp": datetime.now().isoformat(),
        }
    )


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000, threaded=True)
