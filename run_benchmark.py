#!/usr/bin/env python3
import asyncio
import json
import os
import sys
from datetime import datetime
from typing import Dict, Any

import yaml
from dotenv import load_dotenv

from benchmark.task_suite import TaskSuite
from benchmark.evaluator import Evaluator
from agents.prompt_based import PromptBasedAgent
from agents.tool_augmented import ToolAugmentedAgent
from agents.multi_agent import MultiAgentSystem
from utils.llm_client import LLMClient

load_dotenv()


def configure_console_output() -> None:
    """Avoid Windows console crashes when status text includes Unicode."""
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")


class BenchmarkRunner:
    """Main benchmark orchestration."""

    def __init__(self, config_path: str = "config.yaml"):
        with open(config_path, "r") as file_obj:
            self.config = yaml.safe_load(file_obj)

        self.llm_client = LLMClient(
            {
                **self.config,
                "openai_api_key": os.getenv("OPENAI_API_KEY"),
                "ollama_base_url": os.getenv("OLLAMA_BASE_URL"),
            }
        )

        self.task_suite = TaskSuite()
        self.evaluator = Evaluator()
        self.agents = {
            "prompt_based": PromptBasedAgent(self.config, self.llm_client),
            "tool_augmented": ToolAugmentedAgent(self.config, self.llm_client),
            "multi_agent": MultiAgentSystem(self.config, self.llm_client),
        }
        self.results: Dict[str, Any] = {}

    async def run_benchmark(self) -> Dict[str, Any]:
        """Execute complete benchmark."""
        print("=" * 60)
        print("Benchmarking Agent Architectures for Exploit Generation")
        print("=" * 60)

        tasks = self.task_suite.get_all_tasks()
        runs_per_task = self.config.get("benchmark", {}).get("runs_per_task", 5)

        for agent_name, agent in self.agents.items():
            print(f"\n[RUN] {agent_name.upper()} architecture...")
            self.results[agent_name] = {"tasks": [], "aggregate": {}}

            for task in tasks:
                print(f"  [TASK] {task['id']} ({task['task_type']})")
                task_results = []

                for run_num in range(runs_per_task):
                    print(f"    Run {run_num + 1}/{runs_per_task}...")
                    result = await agent.generate_exploit(task)
                    metrics = self.evaluator.evaluate(result, task)
                    task_results.append(
                        {
                            "run": run_num + 1,
                            "result": result.__dict__,
                            "metrics": metrics,
                        }
                    )

                success_rate = sum(
                    1 for item in task_results if item["metrics"]["success"]
                ) / len(task_results)
                avg_accuracy = sum(
                    item["metrics"]["accuracy"]["score"] for item in task_results
                ) / len(task_results)
                avg_efficiency = sum(
                    item["metrics"]["efficiency"]["score"] for item in task_results
                ) / len(task_results)
                avg_robustness = sum(
                    item["metrics"]["robustness"]["score"] for item in task_results
                ) / len(task_results)
                avg_score = sum(item["metrics"]["combined_score"] for item in task_results) / len(
                    task_results
                )
                avg_time = sum(item["result"]["execution_time"] for item in task_results) / len(
                    task_results
                )

                self.results[agent_name]["tasks"].append(
                    {
                        "task_id": task["id"],
                        "task_type": task["task_type"],
                        "runs": task_results,
                        "success_rate": success_rate,
                        "avg_accuracy": avg_accuracy,
                        "avg_efficiency": avg_efficiency,
                        "avg_robustness": avg_robustness,
                        "avg_combined_score": avg_score,
                        "avg_execution_time": avg_time,
                    }
                )

        for agent_name in self.results:
            self._compute_aggregates(agent_name)

        self._generate_report()
        return self.results

    def _compute_aggregates(self, agent_name: str):
        """Compute aggregate statistics per architecture."""
        tasks = self.results[agent_name]["tasks"]

        by_type: Dict[str, Dict[str, list]] = {}
        for task in tasks:
            task_type = task["task_type"]
            if task_type not in by_type:
                by_type[task_type] = {
                    "success_rates": [],
                    "accuracy": [],
                    "efficiency": [],
                    "robustness": [],
                    "scores": [],
                    "times": [],
                }
            by_type[task_type]["success_rates"].append(task["success_rate"])
            by_type[task_type]["accuracy"].append(task["avg_accuracy"])
            by_type[task_type]["efficiency"].append(task["avg_efficiency"])
            by_type[task_type]["robustness"].append(task["avg_robustness"])
            by_type[task_type]["scores"].append(task["avg_combined_score"])
            by_type[task_type]["times"].append(task["avg_execution_time"])

        self.results[agent_name]["aggregate"] = {
            "overall_avg_score": sum(task["avg_combined_score"] for task in tasks) / len(tasks),
            "overall_success_rate": sum(task["success_rate"] for task in tasks) / len(tasks),
            "avg_accuracy": sum(task["avg_accuracy"] for task in tasks) / len(tasks),
            "avg_efficiency": sum(task["avg_efficiency"] for task in tasks) / len(tasks),
            "avg_robustness": sum(task["avg_robustness"] for task in tasks) / len(tasks),
            "overall_avg_time": sum(task["avg_execution_time"] for task in tasks) / len(tasks),
            "by_task_type": {
                task_type: {
                    "avg_score": sum(data["scores"]) / len(data["scores"]),
                    "success_rate": sum(data["success_rates"]) / len(data["success_rates"]),
                    "avg_accuracy": sum(data["accuracy"]) / len(data["accuracy"]),
                    "avg_efficiency": sum(data["efficiency"]) / len(data["efficiency"]),
                    "avg_robustness": sum(data["robustness"]) / len(data["robustness"]),
                    "avg_time": sum(data["times"]) / len(data["times"]),
                }
                for task_type, data in by_type.items()
            },
        }

    def _generate_report(self):
        """Generate JSON report."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        report_dir = self.config.get("benchmark", {}).get("results_dir", "./reports")
        os.makedirs(report_dir, exist_ok=True)

        report_path = f"{report_dir}/benchmark_results_{timestamp}.json"
        with open(report_path, "w") as file_obj:
            json.dump(self.results, file_obj, indent=2, default=str)

        print("\n" + "=" * 100)
        print("BENCHMARK RESULTS SUMMARY")
        print("=" * 100)
        print(
            f"{'Architecture':<20} {'Overall Score':<15} {'Accuracy':<12} "
            f"{'Efficiency':<12} {'Robustness':<12} {'Avg Time (s)':<12}"
        )
        print("-" * 100)

        for agent_name, data in self.results.items():
            aggregate = data["aggregate"]
            print(
                f"{agent_name:<20} {aggregate['overall_avg_score']:<15.3f} "
                f"{aggregate['avg_accuracy']:<12.3f} "
                f"{aggregate['avg_efficiency']:<12.3f} "
                f"{aggregate['avg_robustness']:<12.3f} "
                f"{aggregate['overall_avg_time']:<12.2f}"
            )

        print("=" * 100)
        print(f"Report saved to: {report_path}")


async def main():
    configure_console_output()
    runner = BenchmarkRunner()
    await runner.run_benchmark()


if __name__ == "__main__":
    asyncio.run(main())
