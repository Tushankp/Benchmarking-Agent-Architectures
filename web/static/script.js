document.addEventListener('DOMContentLoaded', () => {
    const taskBtns = document.querySelectorAll('.task-btn');
    const panels = {
        reasoning: document.getElementById('reasoning-panel'),
        retrieval: document.getElementById('retrieval-panel'),
        planning: document.getElementById('planning-panel')
    };

    const generateBtn = document.getElementById('generate-btn');
    const loadingDiv = document.getElementById('loading');
    const comparisonPanel = document.getElementById('comparison-panel');
    const comparisonHighlights = document.getElementById('comparison-highlights');
    const comparisonBody = document.getElementById('comparison-body');
    const comparisonNote = document.getElementById('comparison-note');
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

    const updateCard = (cardSelector, result, activeType) => {
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
                <span class="metric">Accuracy ${formatScore(getMetricScore(result, 'accuracy'))}</span>
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

    const updateComparison = (results, activeType) => {
        const entries = Object.entries(results);
        const successful = entries.filter(([, result]) => result.success);

        comparisonPanel.classList.remove('hidden');
        comparisonBody.innerHTML = entries
            .map(([name, result]) => `
                <tr>
                    <td>${name.replaceAll('_', ' ')}</td>
                    <td>${result.success ? 'Success' : 'Failed'}</td>
                    <td>${(result.execution_time || 0).toFixed(2)}s</td>
                    <td>${result.token_count || 0}</td>
                    <td>${formatScore(getMetricScore(result, 'accuracy'))}</td>
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
                : 'This run compares evaluator scores for generated artifacts across the three agents.';

        comparisonNote.textContent = modeCopy;
        comparisonHighlights.innerHTML = [
            createHighlightCard(
                'Highest accuracy',
                highestAccuracy[0].replaceAll('_', ' '),
                `Scored ${formatScore(getMetricScore(highestAccuracy[1], 'accuracy'))} for accuracy.`
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
    };

    generateBtn.addEventListener('click', async () => {
        const activeType = document.querySelector('.task-btn.active').dataset.type;
        const payload = buildPayload(activeType);
        const agentNames = Object.keys(agentCardSelectors);

        if (!payload.question && !payload.cve_id && !payload.target) {
            alert('Please enter a question, CVE, or target description.');
            return;
        }

        loadingDiv.classList.remove('hidden');
        generateBtn.disabled = true;
        comparisonPanel.classList.add('hidden');
        comparisonHighlights.innerHTML = '';
        comparisonBody.innerHTML = '';

        ['prompt', 'tool', 'multi'].forEach(resetCard);

        try {
            const results = {};
            const requests = agentNames.map(async (agentName) => {
                try {
                    const response = await fetch(`/api/agents/${agentName}/generate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    const data = await response.json();

                    if (!response.ok || data.error) {
                        throw new Error(data.error || `Request failed with status ${response.status}`);
                    }

                    results[agentName] = data.result;
                    updateCard(agentCardSelectors[agentName], data.result, activeType);
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
                    updateCard(agentCardSelectors[agentName], failedResult, activeType);
                }
            });

            await Promise.allSettled(requests);
            updateComparison(results, activeType);
        } finally {
            loadingDiv.classList.add('hidden');
            generateBtn.disabled = false;
        }
    });
});
