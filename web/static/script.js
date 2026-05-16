document.addEventListener('DOMContentLoaded', () => {
    const taskBtns = document.querySelectorAll('.task-btn');
    const panels = {
        reasoning: document.getElementById('reasoning-panel'),
        retrieval: document.getElementById('retrieval-panel'),
        planning: document.getElementById('planning-panel'),
        batch: document.getElementById('batch-panel')
    };

    const generateBtn = document.getElementById('generate-btn');
    const loadingDiv = document.getElementById('loading');
    const comparisonPanel = document.getElementById('comparison-panel');
    const comparisonHighlights = document.getElementById('comparison-highlights');
    const comparisonBody = document.getElementById('comparison-body');
    const comparisonNote = document.getElementById('comparison-note');
    const comparisonLineGraph = document.getElementById('comparison-line-graph');
    const comparisonHistogram = document.getElementById('comparison-histogram');
    const agentCardSelectors = {
        prompt_based: '[data-agent="prompt"]',
        tool_augmented: '[data-agent="tool"]',
        multi_agent: '[data-agent="multi"]'
    };

    taskBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
            taskBtns.forEach((button) => button.classList.remove('active'));
            btn.classList.add('active');

            const type = btn.dataset.type;
            Object.values(panels).forEach((panel) => panel.classList.remove('active'));
            panels[type].classList.add('active');
        });
    });

    // Batch type selector handler
    const batchTypeSelect = document.getElementById('batch-type');
    const agentFieldsMap = {
        prompt_based: document.getElementById('prompt-based-fields'),
        tool_augmented: document.getElementById('tool-augmented-fields'),
        multi_agent: document.getElementById('multi-agent-fields')
    };
    
    const updateBatchInputFields = () => {
        const taskType = batchTypeSelect.value;
        
        Object.entries(agentFieldsMap).forEach(([agentKey, fieldsContainer]) => {
            let fieldHTML = '';
            
            if (taskType === 'reasoning') {
                fieldHTML = `
                    <label>Vulnerability Description / Code Snippet</label>
                    <textarea id="batch-${agentKey}-reasoning-question" rows="4" placeholder="Add reasoning prompt for ${agentKey.replace('_', ' ')}"></textarea>
                    <label>Optional Context</label>
                    <input type="text" id="batch-${agentKey}-reasoning-context" placeholder="Example: No stack canary, NX disabled, ASLR enabled">
                `;
            } else if (taskType === 'retrieval') {
                fieldHTML = `
                    <label>CVE ID</label>
                    <input type="text" id="batch-${agentKey}-cve-id" placeholder="Example: CVE-2021-44228">
                    <label>Description</label>
                    <textarea id="batch-${agentKey}-cve-description" rows="3" placeholder="Describe CVE context for ${agentKey.replace('_', ' ')}"></textarea>
                `;
            } else if (taskType === 'planning') {
                fieldHTML = `
                    <label>Target Description</label>
                    <input type="text" id="batch-${agentKey}-planning-target" placeholder="Example: Internal web server with outdated Apache Struts">
                    <label>Goal</label>
                    <textarea id="batch-${agentKey}-planning-goal" rows="3" placeholder="Example: Gain remote shell and extract /etc/passwd"></textarea>
                `;
            }
            
            fieldsContainer.innerHTML = fieldHTML;
        });
    };
    
    batchTypeSelect.addEventListener('change', updateBatchInputFields);
    updateBatchInputFields(); // Initialize on page load

    const getCard = (agent) => document.querySelector(`.result-card[data-agent="${agent}"]`);
    const formatScore = (score) => `${((score || 0) * 100).toFixed(0)}%`;
    const getMetricScore = (result, metric) =>
        result.metrics && result.metrics[metric] ? result.metrics[metric].score || 0 : 0;

    const isProbablyCode = (text) => {
        if (!text) {
            return false;
        }

        const lowered = text.toLowerCase();
        const codeSignals = [
            'def ',
            'class ',
            'import ',
            'return ',
            '```',
            'payload',
            'socket',
            'for ',
            'while ',
            '{',
            '}'
        ];
        return codeSignals.some((signal) => lowered.includes(signal));
    };

    const resetCard = (agent) => {
        const card = getCard(agent);
        const status = card.querySelector('.status-badge');
        const codeContainer = card.querySelector('.code-block');
        const code = card.querySelector('code');
        const answer = card.querySelector('.answer-block');
        const outputLabel = card.querySelector('.result-output-label');

        status.textContent = 'Processing';
        status.className = 'status-badge';
        card.querySelector('.result-metrics').innerHTML = '';
        card.querySelector('.error-message').textContent = '';
        outputLabel.textContent = 'Generated output';
        answer.textContent = '';
        answer.classList.add('hidden');
        code.textContent = '';
        codeContainer.classList.remove('hidden');
        hljs.highlightElement(code);
    };

    const buildPayload = (activeType) => {
        const payload = { task_type: activeType };

        if (activeType === 'reasoning') {
            payload.question = document.getElementById('reasoning-question').value;
            payload.context = document.getElementById('reasoning-context').value;
            payload.code_snippet = payload.question;
        } else if (activeType === 'retrieval') {
            payload.cve_id = document.getElementById('cve-id').value;
            payload.question =
                document.getElementById('cve-description').value || `Generate exploit for ${payload.cve_id}`;
            payload.description = payload.question;
        } else if (activeType === 'planning') {
            payload.target = document.getElementById('planning-target').value;
            payload.goal = document.getElementById('planning-goal').value;
            payload.question = `Target: ${payload.target}\nGoal: ${payload.goal}`;
        } else if (activeType === 'batch') {
            const taskType = document.getElementById('batch-type').value;
            payload.task_type = taskType;
            
            // Get selected agents
            const agentCheckboxes = document.querySelectorAll('input[name="batch-agents"]:checked');
            payload.selected_agents = Array.from(agentCheckboxes).map(cb => cb.value);
            
            // Collect agent-specific inputs
            payload.agent_inputs = {};
            payload.selected_agents.forEach(agentKey => {
                const agentPayload = { task_type: taskType };
                
                if (taskType === 'reasoning') {
                    agentPayload.question = document.getElementById(`batch-${agentKey}-reasoning-question`).value;
                    agentPayload.context = document.getElementById(`batch-${agentKey}-reasoning-context`).value;
                    agentPayload.code_snippet = agentPayload.question;
                } else if (taskType === 'retrieval') {
                    agentPayload.cve_id = document.getElementById(`batch-${agentKey}-cve-id`).value;
                    agentPayload.question = document.getElementById(`batch-${agentKey}-cve-description`).value || `Generate exploit for ${agentPayload.cve_id}`;
                    agentPayload.description = agentPayload.question;
                } else if (taskType === 'planning') {
                    agentPayload.target = document.getElementById(`batch-${agentKey}-planning-target`).value;
                    agentPayload.goal = document.getElementById(`batch-${agentKey}-planning-goal`).value;
                    agentPayload.question = `Target: ${agentPayload.target}\nGoal: ${agentPayload.goal}`;
                }
                
                payload.agent_inputs[agentKey] = agentPayload;
            });
        }

        return payload;
    };

    const renderOutput = (card, result, activeType) => {
        const codeContainer = card.querySelector('.code-block');
        const codeBlock = card.querySelector('code');
        const answerBlock = card.querySelector('.answer-block');
        const outputLabel = card.querySelector('.result-output-label');
        const content = result.exploit_code || '';
        const showAsAnswer = activeType === 'reasoning' && !isProbablyCode(content);

        if (showAsAnswer) {
            outputLabel.textContent = 'Agent answer';
            codeContainer.classList.add('hidden');
            answerBlock.classList.remove('hidden');
            answerBlock.textContent = content || 'No answer generated.';
            return;
        }

        outputLabel.textContent = 'Generated code';
        answerBlock.classList.add('hidden');
        codeContainer.classList.remove('hidden');
        codeBlock.textContent = content || '# No code generated';
        hljs.highlightElement(codeBlock);
    };

    const updateCard = (cardSelector, result, activeType, displayAccuracy = null) => {
        const card = document.querySelector(cardSelector);
        const statusSpan = card.querySelector('.status-badge');
        const metricsDiv = card.querySelector('.result-metrics');
        const errorDiv = card.querySelector('.error-message');

        if (result.success) {
            statusSpan.textContent = 'Success';
            statusSpan.classList.add('success');
            renderOutput(card, result, activeType);
            metricsDiv.innerHTML = `
                <span class="metric">Time ${result.execution_time.toFixed(2)}s</span>
                <span class="metric">Tokens ${result.token_count || 0}</span>
                <span class="metric">Accuracy ${formatScore(
                    displayAccuracy !== null ? displayAccuracy : getMetricScore(result, 'accuracy')
                )}</span>
                <span class="metric">Efficiency ${formatScore(getMetricScore(result, 'efficiency'))}</span>
                <span class="metric">Robustness ${formatScore(getMetricScore(result, 'robustness'))}</span>
            `;
        } else {
            statusSpan.textContent = 'Failed';
            statusSpan.classList.add('error');
            renderOutput(card, { exploit_code: '# Generation failed' }, 'planning');
            errorDiv.textContent = `Error: ${result.error || 'Unknown error'}`;
        }
    };

    const createHighlightCard = (label, value, subtext) => `
        <div class="highlight-card">
            <p class="highlight-label">${label}</p>
            <p class="highlight-value">${value}</p>
            <p class="highlight-subtext">${subtext}</p>
        </div>
    `;

    const drawComparisonLineGraph = (results, relativeAccuracy) => {
        const successful = Object.entries(results).filter(([, result]) => result.success);
        if (!successful.length) {
            comparisonLineGraph.innerHTML = '';
            return;
        }

        const width = 640;
        const height = 220;
        const padding = { top: 20, right: 16, bottom: 42, left: 42 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const maxX = Math.max(successful.length - 1, 1);
        const xAt = (index) => padding.left + (chartWidth * index) / maxX;
        const yAt = (score) => padding.top + chartHeight - score * chartHeight;

        const series = [
            { key: 'accuracy', label: 'Accuracy', color: '#73b7ff', useRelative: true },
            { key: 'efficiency', label: 'Efficiency', color: '#5ce2b4', useRelative: false },
            { key: 'robustness', label: 'Robustness', color: '#ffb366', useRelative: false }
        ];

        const buildPoints = (seriesDef) =>
            successful
                .map(([name, result], index) => {
                    const score = seriesDef.useRelative
                        ? (relativeAccuracy[name] ?? 0)
                        : getMetricScore(result, seriesDef.key);
                    return `${xAt(index)},${yAt(Math.max(0, Math.min(score, 1)))}`;
                })
                .join(' ');

        const xLabels = successful
            .map(([name], index) => {
                const label = name.replaceAll('_', ' ');
                return `<text x="${xAt(index)}" y="${height - 16}" fill="#d0d0d0" font-size="11" text-anchor="middle">${label}</text>`;
            })
            .join('');

        const yGrid = [0, 0.25, 0.5, 0.75, 1]
            .map((mark) => {
                const y = yAt(mark);
                return `
                    <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="rgba(255,255,255,0.14)" stroke-width="1" />
                    <text x="${padding.left - 8}" y="${y + 4}" fill="#d0d0d0" font-size="10" text-anchor="end">${Math.round(mark * 100)}%</text>
                `;
            })
            .join('');

        const linePaths = series
            .map(
                (seriesDef) =>
                    `<polyline fill="none" stroke="${seriesDef.color}" stroke-width="2.5" points="${buildPoints(seriesDef)}" />`
            )
            .join('');

        const pointDots = series
            .map((seriesDef) =>
                successful
                    .map(([name, result], index) => {
                        const score = seriesDef.useRelative
                            ? (relativeAccuracy[name] ?? 0)
                            : getMetricScore(result, seriesDef.key);
                        return `<circle cx="${xAt(index)}" cy="${yAt(Math.max(0, Math.min(score, 1)))}" r="3.2" fill="${seriesDef.color}" />`;
                    })
                    .join('')
            )
            .join('');

        const legend = series
            .map(
                (seriesDef, index) => `
                    <rect x="${padding.left + index * 150}" y="4" width="14" height="3.5" fill="${seriesDef.color}" rx="2" />
                    <text x="${padding.left + 18 + index * 150}" y="10" fill="#d0d0d0" font-size="10">${seriesDef.label}</text>
                `
            )
            .join('');

        comparisonLineGraph.innerHTML = `
            <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Comparison line graph">
                <rect x="0" y="0" width="${width}" height="${height}" fill="transparent" />
                ${yGrid}
                <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" stroke="rgba(255,255,255,0.2)" />
                <line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}" stroke="rgba(255,255,255,0.2)" />
                ${linePaths}
                ${pointDots}
                ${xLabels}
                ${legend}
            </svg>
        `;
    };

    const drawComparisonHistogram = (results, relativeAccuracy) => {
        const successful = Object.entries(results).filter(([, result]) => result.success);
        if (!successful.length) {
            comparisonHistogram.innerHTML = '';
            return;
        }

        const width = 640;
        const height = 220;
        const padding = { top: 20, right: 16, bottom: 42, left: 42 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const barGap = 16;
        const barWidth = Math.max((chartWidth - barGap * (successful.length - 1)) / successful.length, 24);

        const bars = successful
            .map(([name], index) => {
                const score = Math.max(0, Math.min(relativeAccuracy[name] ?? 0, 1));
                const x = padding.left + index * (barWidth + barGap);
                const h = score * chartHeight;
                const y = padding.top + chartHeight - h;
                const label = name.replaceAll('_', ' ');
                return `
                    <rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="url(#barBlue)" rx="6" />
                    <text x="${x + barWidth / 2}" y="${y - 6}" fill="#ffffff" font-size="11" text-anchor="middle">${Math.round(score * 100)}%</text>
                    <text x="${x + barWidth / 2}" y="${height - 16}" fill="#d0d0d0" font-size="11" text-anchor="middle">${label}</text>
                `;
            })
            .join('');

        const yGrid = [0, 0.25, 0.5, 0.75, 1]
            .map((mark) => {
                const y = padding.top + chartHeight - mark * chartHeight;
                return `
                    <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="rgba(255,255,255,0.14)" stroke-width="1" />
                    <text x="${padding.left - 8}" y="${y + 4}" fill="#d0d0d0" font-size="10" text-anchor="end">${Math.round(mark * 100)}%</text>
                `;
            })
            .join('');

        comparisonHistogram.innerHTML = `
            <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Relative accuracy histogram">
                <defs>
                    <linearGradient id="barBlue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="#67b8ff" />
                        <stop offset="100%" stop-color="#1f5db3" />
                    </linearGradient>
                </defs>
                ${yGrid}
                <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" stroke="rgba(255,255,255,0.2)" />
                <line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}" stroke="rgba(255,255,255,0.2)" />
                ${bars}
            </svg>
        `;
    };

    const getRelativeAccuracyByAgent = (results) => {
        const entries = Object.entries(results).filter(([, result]) => result.success);
        if (!entries.length) {
            return {};
        }

        const topAgent = entries.reduce((best, current) =>
            getMetricScore(current[1], 'accuracy') > getMetricScore(best[1], 'accuracy') ? current : best
        )[0];
        const topScore = getMetricScore(results[topAgent], 'accuracy');
        const relativeScores = {};

        Object.entries(results).forEach(([agentName, result]) => {
            if (!result.success || topScore <= 0) {
                relativeScores[agentName] = 0;
                return;
            }

            if (agentName === topAgent) {
                relativeScores[agentName] = 1;
                return;
            }

            const rawRatio = getMetricScore(result, 'accuracy') / topScore;
            // Ensure every non-top agent stays at least 3% below the top (100% vs max 97%).
            relativeScores[agentName] = Math.min(Math.max(rawRatio, 0), 0.97);
        });

        return relativeScores;
    };

    const updateComparison = (results, activeType) => {
        const entries = Object.entries(results);
        const successful = entries.filter(([, result]) => result.success);
        const relativeAccuracy = getRelativeAccuracyByAgent(results);

        comparisonPanel.classList.remove('hidden');
        comparisonBody.innerHTML = entries
            .map(([name, result]) => `
                <tr>
                    <td>${name.replaceAll('_', ' ')}</td>
                    <td>${result.success ? 'Success' : 'Failed'}</td>
                    <td>${(result.execution_time || 0).toFixed(2)}s</td>
                    <td>${result.token_count || 0}</td>
                    <td>${formatScore(relativeAccuracy[name] ?? 0)}</td>
                    <td>${formatScore(getMetricScore(result, 'efficiency'))}</td>
                    <td>${formatScore(getMetricScore(result, 'robustness'))}</td>
                </tr>
            `)
            .join('');

        if (!successful.length) {
            comparisonHighlights.innerHTML = createHighlightCard(
                'Run result',
                'No successful outputs',
                'All agents failed on this request, so there is nothing meaningful to compare yet.'
            );
            comparisonNote.textContent = 'Try a different prompt or check provider configuration.';
            drawComparisonLineGraph(results, relativeAccuracy);
            drawComparisonHistogram(results, relativeAccuracy);
            return;
        }

        const highestAccuracy = successful.reduce((best, current) =>
            getMetricScore(current[1], 'accuracy') > getMetricScore(best[1], 'accuracy') ? current : best
        );
        const bestEfficiency = successful.reduce((best, current) =>
            getMetricScore(current[1], 'efficiency') > getMetricScore(best[1], 'efficiency') ? current : best
        );
        const highestRobustness = successful.reduce((best, current) =>
            getMetricScore(current[1], 'robustness') > getMetricScore(best[1], 'robustness') ? current : best
        );

        const modeCopy =
            activeType === 'reasoning'
                ? 'This run compares evaluator scores for answer quality, efficiency, and robustness.'
                : activeType === 'batch'
                  ? 'This batch comparison evaluates selected agents against the same input and compares their scores.'
                  : 'This run compares evaluator scores for generated artifacts across the three agents.';

        comparisonNote.textContent = modeCopy;
        comparisonHighlights.innerHTML = [
            createHighlightCard(
                'Highest accuracy',
                highestAccuracy[0].replaceAll('_', ' '),
                `Set to ${formatScore(relativeAccuracy[highestAccuracy[0]] ?? 1)} in this relative comparison.`
            ),
            createHighlightCard(
                'Best efficiency',
                bestEfficiency[0].replaceAll('_', ' '),
                `Scored ${formatScore(getMetricScore(bestEfficiency[1], 'efficiency'))} for efficiency.`
            ),
            createHighlightCard(
                'Highest robustness',
                highestRobustness[0].replaceAll('_', ' '),
                `Scored ${formatScore(getMetricScore(highestRobustness[1], 'robustness'))} for robustness.`
            )
        ].join('');

        drawComparisonLineGraph(results, relativeAccuracy);
        drawComparisonHistogram(results, relativeAccuracy);
    };

    generateBtn.addEventListener('click', async () => {
        const activeType = document.querySelector('.task-btn.active').dataset.type;
        const payload = buildPayload(activeType);
        let agentNames = Object.keys(agentCardSelectors);
        
        // Handle batch mode
        if (activeType === 'batch') {
            if (!payload.selected_agents || payload.selected_agents.length === 0) {
                alert('Please select at least one agent for batch comparison.');
                return;
            }
            agentNames = payload.selected_agents;
            
            // Validate agent-specific inputs
            const taskType = document.getElementById('batch-type').value;
            let hasValidInput = true;
            
            for (const agentKey of payload.selected_agents) {
                if (taskType === 'reasoning') {
                    const question = document.getElementById(`batch-${agentKey}-reasoning-question`).value;
                    if (!question.trim()) {
                        alert(`Please enter reasoning question for ${agentKey.replace('_', ' ')}.`);
                        hasValidInput = false;
                        break;
                    }
                } else if (taskType === 'retrieval') {
                    const cveId = document.getElementById(`batch-${agentKey}-cve-id`).value;
                    if (!cveId.trim()) {
                        alert(`Please enter CVE ID for ${agentKey.replace('_', ' ')}.`);
                        hasValidInput = false;
                        break;
                    }
                } else if (taskType === 'planning') {
                    const target = document.getElementById(`batch-${agentKey}-planning-target`).value;
                    const goal = document.getElementById(`batch-${agentKey}-planning-goal`).value;
                    if (!target.trim() || !goal.trim()) {
                        alert(`Please enter both target and goal for ${agentKey.replace('_', ' ')}.`);
                        hasValidInput = false;
                        break;
                    }
                }
            }
            
            if (!hasValidInput) return;
        } else if (!payload.question && !payload.cve_id && !payload.target) {
            alert('Please enter a question, CVE, or target description.');
            return;
        }

        loadingDiv.classList.remove('hidden');
        generateBtn.disabled = true;
        comparisonPanel.classList.add('hidden');
        comparisonHighlights.innerHTML = '';
        comparisonBody.innerHTML = '';
        comparisonLineGraph.innerHTML = '';
        comparisonHistogram.innerHTML = '';

        ['prompt', 'tool', 'multi'].forEach(resetCard);
        
        // Hide unselected agent cards in batch mode
        if (activeType === 'batch') {
            ['prompt_based', 'tool_augmented', 'multi_agent'].forEach(agentName => {
                const card = getCard(agentCardSelectors[agentName].replace('[data-agent="', '').replace('"]', ''));
                if (card) {
                    card.style.display = payload.selected_agents.includes(agentName) ? 'block' : 'none';
                }
            });
        }

        try {
            const results = {};
            const requests = agentNames.map(async (agentName) => {
                    try {
                        // Use agent-specific payload for batch mode
                        const requestPayload = activeType === 'batch' ? payload.agent_inputs[agentName] : payload;
                        
                        const response = await fetch(`/api/agents/${agentName}/generate`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(requestPayload)
                        });
                        const data = await response.json();

                        if (!response.ok || data.error) {
                            throw new Error(data.error || `Request failed with status ${response.status}`);
                        }

                        results[agentName] = data.result;
                        updateCard(
                            agentCardSelectors[agentName],
                            data.result,
                            activeType,
                            getMetricScore(data.result, 'accuracy')
                        );
                    } catch (error) {
                        const failedResult = {
                            success: false,
                            exploit_code: null,
                            execution_time: 0,
                            token_count: 0,
                            metrics: {
                                accuracy: { score: 0 },
                                efficiency: { score: 0 },
                                robustness: { score: 0 }
                            },
                            error: error.message || 'Unknown error'
                        };
                        results[agentName] = failedResult;
                        updateCard(agentCardSelectors[agentName], failedResult, activeType, 0);
                    }
                });

                await Promise.allSettled(requests);
            const relativeAccuracy = getRelativeAccuracyByAgent(results);
            Object.entries(results).forEach(([agentName, result]) => {
                updateCard(
                    agentCardSelectors[agentName],
                    result,
                    activeType,
                    relativeAccuracy[agentName] ?? 0
                );
            });
            updateComparison(results, activeType);
        } finally {
            loadingDiv.classList.add('hidden');
            generateBtn.disabled = false;
        }
    });
});
