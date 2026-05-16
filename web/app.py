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


def build_batch_tasks(data: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Build reasoning, retrieval, and planning tasks from one payload."""
    batch = data.get("batch") or {}
    timestamp = int(time.time())

    reasoning = {
        "id": f"user_{timestamp}_reasoning",
        "task_type": "reasoning",
        "description": (batch.get("reasoning_question") or "").strip(),
        "code_snippet": (batch.get("reasoning_question") or "").strip(),
        "context": (batch.get("reasoning_context") or "").strip(),
        "cve_id": "",
        "target_description": "",
        "goal": (batch.get("reasoning_question") or "").strip(),
    }

    retrieval_desc = (batch.get("cve_description") or "").strip()
    retrieval_cve = (batch.get("cve_id") or "").strip()
    retrieval = {
        "id": f"user_{timestamp}_retrieval",
        "task_type": "retrieval",
        "description": retrieval_desc or (f"Generate exploit for {retrieval_cve}" if retrieval_cve else ""),
        "code_snippet": "",
        "context": "",
        "cve_id": retrieval_cve,
        "target_description": "",
        "goal": retrieval_desc or retrieval_cve,
    }

    planning_target = (batch.get("planning_target") or "").strip()
    planning_goal = (batch.get("planning_goal") or "").strip()
    planning = {
        "id": f"user_{timestamp}_planning",
        "task_type": "planning",
        "description": f"Target: {planning_target}\nGoal: {planning_goal}".strip(),
        "code_snippet": "",
        "context": "",
        "cve_id": "",
        "target_description": planning_target,
        "goal": planning_goal,
    }

    return {"reasoning": reasoning, "retrieval": retrieval, "planning": planning}


def validate_batch_tasks(tasks: Dict[str, Dict[str, Any]]) -> str | None:
    """Ensure all 3 batch tasks are valid."""
    for task_type in ("reasoning", "retrieval", "planning"):
        validation_error = validate_task(tasks[task_type])
        if validation_error:
            return f"{task_type}: {validation_error}"
    return None


def build_batch_input_tasks(data: Dict[str, Any]) -> list[Dict[str, Any]]:
    """Build a list of tasks from user-provided batch input items."""
    batch_input = data.get("batch_input") or {}
    batch_task_type = (batch_input.get("task_type") or "reasoning").strip().lower()
    items = batch_input.get("items") or []
    timestamp = int(time.time())
    tasks: list[Dict[str, Any]] = []

    for idx, raw_item in enumerate(items):
        item = raw_item if isinstance(raw_item, dict) else {}
        task: Dict[str, Any]
        if batch_task_type == "retrieval":
            cve_id = (item.get("cve_id") or "").strip()
            description = (item.get("description") or "").strip()
            task = {
                "id": f"user_{timestamp}_batch_input_{idx}_retrieval",
                "task_type": "retrieval",
                "description": description or (f"Generate exploit for {cve_id}" if cve_id else ""),
                "code_snippet": "",
                "context": "",
                "cve_id": cve_id,
                "target_description": "",
                "goal": description or cve_id,
            }
        elif batch_task_type == "planning":
            target = (item.get("target") or "").strip()
            goal = (item.get("goal") or "").strip()
            task = {
                "id": f"user_{timestamp}_batch_input_{idx}_planning",
                "task_type": "planning",
                "description": f"Target: {target}\nGoal: {goal}".strip(),
                "code_snippet": "",
                "context": "",
                "cve_id": "",
                "target_description": target,
                "goal": goal,
            }
        else:
            question = (item.get("question") or "").strip()
            context = (item.get("context") or "").strip()
            task = {
                "id": f"user_{timestamp}_batch_input_{idx}_reasoning",
                "task_type": "reasoning",
                "description": question,
                "code_snippet": question,
                "context": context,
                "cve_id": "",
                "target_description": "",
                "goal": question,
            }
        tasks.append(task)

    return tasks


def validate_batch_input_tasks(tasks: list[Dict[str, Any]]) -> str | None:
    """Validate parsed batch input tasks."""
    if not tasks:
        return "batch_input requires at least one item"

    for idx, task in enumerate(tasks):
        validation_error = validate_task(task)
        if validation_error:
            return f"item {idx + 1}: {validation_error}"
    return None


def aggregate_batch_input_agent_result(agent_name: str, task_results: list[Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregate many same-type tasks into one per-agent summary."""
    success_count = sum(1 for result in task_results if result.get("success"))

    def avg_metric(metric_name: str) -> float:
        if not task_results:
            return 0.0
        return sum(
            result.get("metrics", {}).get(metric_name, {}).get("score", 0.0) for result in task_results
        ) / len(task_results)

    combined_output = "\n\n".join(
        f"# ITEM {idx + 1}\n{(result.get('exploit_code') or '# No output')}"
        for idx, result in enumerate(task_results)
    )
    errors = [f"item {idx + 1}: {result.get('error')}" for idx, result in enumerate(task_results) if result.get("error")]

    return {
        "task_id": f"batch_input_{int(time.time())}_{agent_name}",
        "task_type": "batch_input",
        "architecture": agent_name,
        "success": success_count > 0,
        "exploit_code": combined_output,
        "execution_time": sum(result.get("execution_time", 0.0) for result in task_results),
        "token_count": sum(result.get("token_count", 0) for result in task_results),
        "metrics": {
            "accuracy": {"score": avg_metric("accuracy"), "details": "Averaged across batch input items"},
            "efficiency": {"score": avg_metric("efficiency"), "details": "Averaged across batch input items"},
            "robustness": {"score": avg_metric("robustness"), "details": "Averaged across batch input items"},
            "combined_score": sum(result.get("metrics", {}).get("combined_score", 0.0) for result in task_results)
            / (len(task_results) or 1),
        },
        "error": "; ".join(errors) if errors else None,
        "steps": [{"item_index": idx, "result": result} for idx, result in enumerate(task_results)],
        "timestamp": datetime.now().isoformat(),
    }


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


def aggregate_agent_batch_result(agent_name: str, task_results: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregate 3 task results into one comparison-friendly payload."""
    ordered_types = ("reasoning", "retrieval", "planning")
    runs = [task_results[t] for t in ordered_types if t in task_results]
    success_count = sum(1 for run in runs if run.get("success"))

    def avg_metric(metric_name: str) -> float:
        if not runs:
            return 0.0
        return sum(
            run.get("metrics", {}).get(metric_name, {}).get("score", 0.0) for run in runs
        ) / len(runs)

    combined_output = "\n\n".join(
        f"# {task_type.upper()}\n{(task_results.get(task_type, {}).get('exploit_code') or '# No output')}"
        for task_type in ordered_types
    )

    errors = [
        f"{task_type}: {task_results[task_type].get('error')}"
        for task_type in ordered_types
        if task_results.get(task_type, {}).get("error")
    ]

    return {
        "task_id": f"batch_{int(time.time())}_{agent_name}",
        "task_type": "batch",
        "architecture": agent_name,
        "success": success_count > 0,
        "exploit_code": combined_output,
        "execution_time": sum(run.get("execution_time", 0.0) for run in runs),
        "token_count": sum(run.get("token_count", 0) for run in runs),
        "metrics": {
            "accuracy": {"score": avg_metric("accuracy"), "details": "Averaged across reasoning/retrieval/planning"},
            "efficiency": {"score": avg_metric("efficiency"), "details": "Averaged across reasoning/retrieval/planning"},
            "robustness": {"score": avg_metric("robustness"), "details": "Averaged across reasoning/retrieval/planning"},
            "combined_score": sum(run.get("metrics", {}).get("combined_score", 0.0) for run in runs)
            / (len(runs) or 1),
        },
        "error": "; ".join(errors) if errors else None,
        "steps": [
            {"task_type": task_type, "result": task_results.get(task_type, {})}
            for task_type in ordered_types
        ],
        "timestamp": datetime.now().isoformat(),
    }


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


@app.route("/api/batch-generate", methods=["POST"])
def batch_generate():
    """Run reasoning + retrieval + planning for all agents and aggregate by agent."""
    data = request.get_json(silent=True) or {}
    tasks = build_batch_tasks(data)
    validation_error = validate_batch_tasks(tasks)

    if validation_error:
        return jsonify({"error": validation_error}), 400

    aggregated_results: Dict[str, Dict[str, Any]] = {}
    for agent_name in AGENTS:
        per_task_results: Dict[str, Dict[str, Any]] = {}
        for task_type, task in tasks.items():
            try:
                per_task_results[task_type] = execute_agent(agent_name, task)
            except Exception as exc:
                per_task_results[task_type] = {
                    "success": False,
                    "exploit_code": None,
                    "execution_time": 0,
                    "token_count": 0,
                    "metrics": evaluator.empty_metrics(task, error=str(exc)),
                    "error": str(exc),
                    "steps": [],
                }
        aggregated_results[agent_name] = aggregate_agent_batch_result(agent_name, per_task_results)

    return jsonify(
        {
            "task": {"task_type": "batch", "tasks": tasks},
            "results": aggregated_results,
            "timestamp": datetime.now().isoformat(),
        }
    )


@app.route("/api/batch-input-generate", methods=["POST"])
def batch_input_generate():
    """Run a list of same-type tasks and aggregate by agent."""
    data = request.get_json(silent=True) or {}
    tasks = build_batch_input_tasks(data)
    validation_error = validate_batch_input_tasks(tasks)

    if validation_error:
        return jsonify({"error": validation_error}), 400

    per_item_results: list[Dict[str, Any]] = []
    per_agent_results: Dict[str, list[Dict[str, Any]]] = {agent_name: [] for agent_name in AGENTS}

    for idx, task in enumerate(tasks):
        item_result: Dict[str, Any] = {
            "item_index": idx,
            "task": task,
            "results": {},
        }
        for agent_name in AGENTS:
            try:
                result = execute_agent(agent_name, task)
            except Exception as exc:
                result = {
                    "success": False,
                    "exploit_code": None,
                    "execution_time": 0,
                    "token_count": 0,
                    "metrics": evaluator.empty_metrics(task, error=str(exc)),
                    "error": str(exc),
                    "steps": [],
                }
            item_result["results"][agent_name] = result
            per_agent_results[agent_name].append(result)
        per_item_results.append(item_result)

    aggregated_results = {
        agent_name: aggregate_batch_input_agent_result(agent_name, task_results)
        for agent_name, task_results in per_agent_results.items()
    }

    return jsonify(
        {
            "task": {"task_type": "batch_input", "tasks": tasks},
            "item_results": per_item_results,
            "results": aggregated_results,
            "timestamp": datetime.now().isoformat(),
        }
    )


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000, threaded=True)
