import { MODEL_OPTIONS, MODELS, LIMITS, modelName } from './models.js';
import { WORKLOAD_SHARES, DEMO_INPUT, blankInput, calculateSavings, makeSetup } from './data.js';

const root = document.querySelector('#root');
let input = blankInput();
let submitted = null;
let benchmark = null;
let candidateIndex = 0;
let acceptedIndex = null;
let spending = { monthlySpend: '', share: '' };
let estimate = null;
let exhausted = false;
let progressEvents = [];
let benchmarkError = '';
let activeController = null;
let preflightController = null;
let confirmation = null;

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const dollars = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
const cents = value => `${(value * 100).toFixed(value < 0.0001 ? 4 : 2)}¢`;
const preciseDollars = value => `$${value.toFixed(6)}`;
const reductionLabel = value => value < 0.01 ? '<1' : String(Math.min(99, Math.round(value * 100)));
const percent = value => Math.round(value * 100);
const arrow = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const check = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const cross = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" fill="currentColor"/></svg>';
const down = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4v16m-6-6 6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function header(page) {
  return `<header class="site-header wrap">
    <a class="brand" href="#home" aria-label="AI Bill Doctor home"><span class="brand-icon">${cross}</span><span>AI Bill Doctor<span class="brand-dot">.</span></span></a>
    <div class="header-right"><span class="preview-pill"><span></span> Local benchmark</span>${page !== 'home' ? '<a class="header-link" href="#input">Edit request</a>' : ''}</div>
  </header>`;
}

function footer() {
  return '<footer class="site-footer wrap"><span>Spend less. Keep building.</span><span>No signup. Your key is never stored.</span></footer>';
}

function steps(active) {
  return `<nav class="steps" aria-label="Your progress">${['One request', 'Try alternatives', 'You decide', 'Your savings'].map((label, i) => `<span class="step ${i === active ? 'active' : ''} ${i < active ? 'done' : ''}" ${i === active ? 'aria-current="step"' : ''}><span class="step-dot">${i < active ? check : i + 1}</span><span>${label}</span></span>${i < 3 ? '<span class="step-line" aria-hidden="true"></span>' : ''}`).join('')}</nav>`;
}

function landing() {
  return `<main class="landing" id="main"><section class="hero wrap">
    <div class="hero-copy"><span class="eyebrow">More money for your next big thing</span><h1 tabindex="-1">Cut your<br><em>AI bill.</em></h1><p class="hero-description">Paste one real AI request.<br>We'll try to run it cheaper.</p><a href="#input" class="button primary hero-cta">Find my savings ${arrow}</a><p class="hero-support">No signup. Takes about 2 minutes.</p><button class="text-button sample-link" data-action="demo">Or try a sample request <span aria-hidden="true">↗</span></button></div>
    <div class="receipt-scene" aria-label="The same task with a smaller bill"><div class="saving-sticker">Keep<br><strong>more.</strong>${down}</div><div class="receipt"><div class="receipt-top">${cross}<span>YOUR AI BILL</span></div><div class="receipt-rule"></div><div class="receipt-line"><span>Your task</span><strong>Same.</strong></div><div class="receipt-line"><span>Your standards</span><strong>Yours.</strong></div><div class="receipt-rule"></div><div class="receipt-total"><span>What you pay?</span><strong>Let's cut it.</strong></div><div class="receipt-note">One request. Let's see what's possible.</div><div class="barcode" aria-hidden="true"></div><span class="receipt-fine">LESS SPENT. MORE LEFT OVER.</span></div><span class="hand-note">A smaller bill looks good on you.</span></div>
  </section><section class="how-section wrap" aria-label="How it works"><div class="how-grid"><p><span>01</span>Paste one request.</p><p><span>02</span>Pick an output you'd ship.</p><p><span>03</span>Take the savings.</p></div><p class="mock-note">Real model calls · Your OpenAI key · You decide on quality.</p></section></main>`;
}

function estimatePage() {
  return `<main id="main" class="wrap estimate-page page-content">${steps(3)}<div class="acceptance-message">${check}<span>Great. Let's see what that could save you.</span></div><div class="page-heading centered"><h1 tabindex="-1">What could this<br><em>save you?</em></h1></div>
    <form id="spending-form" class="spending-card" novalidate><label for="monthlySpend">What's your monthly AI bill?</label><div class="big-money-input"><span>$</span><input id="monthlySpend" name="monthlySpend" type="number" min="0" max="1000000000" step="0.01" inputmode="decimal" placeholder="1,000" value="${escape(spending.monthlySpend)}" required><span>/ month</span></div>
    <fieldset class="share-options"><legend>How much of your AI usage looks like this?</legend><div>${WORKLOAD_SHARES.map(choice => `<label class="share-choice"><input type="radio" name="share" value="${choice.id}" ${spending.share === choice.id ? 'checked' : ''} required><span>${choice.label}</span></label>`).join('')}</div></fieldset><p class="spending-hint">A rough guess is enough.</p><p id="form-error" class="form-error" role="alert"></p><button class="button primary full-width" type="submit">Show my savings ${arrow}</button></form><button class="text-button muted" data-action="back-to-output">Back to the output</button></main>`;
}

function inputPage() {
  return `<main id="main" class="wrap input-page page-content">${steps(0)}<div class="page-heading"><h1 tabindex="-1">One request.<br><em>Let's make it cheaper.</em></h1><p>Paste something your AI does every day.</p></div>
    <form id="request-form" class="form-card" novalidate autocomplete="off">
      <div class="input-top"><div class="field model-field"><label for="model">Current model</label><select id="model" name="model" required><option value="">Choose your model</option>${MODEL_OPTIONS.map(model => `<option value="${model.id}" ${input.model === model.id ? 'selected' : ''}>${model.name}</option>`).join('')}</select></div><button type="button" class="small-button" data-action="demo">Load sample data</button></div>
      <p class="input-help">Only the listed models are supported in V0. Choose the model you actually use. Text requests only.</p>
      <div class="field"><label for="request">Your AI request</label><textarea id="request" name="request" rows="6" maxlength="48000" placeholder="Paste a real request here, including the context you send with it…" required>${escape(input.request)}</textarea></div>
      <details class="optional-input" ${input.system ? 'open' : ''}><summary><span>System prompt / instructions <small>Optional</small></span><span class="chevron" aria-hidden="true"></span></summary><label class="sr-only" for="system">System prompt / instructions</label><textarea id="system" name="system" rows="3" maxlength="48000" placeholder="Any instructions you send before the request…">${escape(input.system)}</textarea></details>
      <details class="optional-input" ${input.response ? 'open' : ''}><summary><span>Original response <small>Optional</small></span><span class="chevron" aria-hidden="true"></span></summary><label class="sr-only" for="response">Original response</label><textarea id="response" name="response" rows="4" maxlength="50000" placeholder="Have the original answer? Paste it here to compare side by side…">${escape(input.response)}</textarea><p class="input-help">We'll show your pasted answer. To measure cost, we still need one fresh call to your current model; its answer may differ.</p></details>
      <div class="field key-field"><label for="apiKey">Temporary OpenAI API key</label><input id="apiKey" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="512" required aria-describedby="key-help"><p id="key-help" class="input-help">Used only to run this benchmark. Not stored.</p></div>
      <div id="budget-confirmation" class="budget-confirmation" role="status"></div><p id="form-error" class="form-error" role="alert"></p><button id="run-button" class="button primary full-width" type="submit">Find a cheaper way ${arrow}</button><p class="form-note">Real calls billed to your OpenAI account. Up to 3 calls. We ask before exceeding the local budget (default $0.05).</p><details class="privacy-details"><summary>What gets sent?</summary><p>Your key goes to this local server and OpenAI. Your request and instructions go to OpenAI; a pasted original response stays local. We use store: false. OpenAI's own data retention policies still apply.</p></details>
    </form></main>`;
}

function analysisPage() {
  const events = progressEvents;
  const hasError = Boolean(benchmarkError);
  return `<main id="main" class="wrap challenge-page page-content">${steps(1)}<div class="challenge-heading"><span class="challenge-icon" aria-hidden="true">${down}</span><h1 tabindex="-1">${hasError ? 'Let’s try that again.' : 'Challenge accepted.'}</h1><p>${hasError ? 'No savings comparison was made.' : "Let's see how low we can go."}</p></div><div class="challenge-list" aria-live="polite">${events.map(step => `<div class="challenge-item ${step.state === 'running' && !hasError ? 'current' : step.state === 'waiting' ? '' : 'complete'}"><span class="challenge-status ${step.state === 'failed' ? 'rejected' : ''}">${step.state === 'running' && !hasError ? '<span class="spinner" aria-label="in progress"></span>' : step.state === 'complete' ? check : step.state === 'waiting' ? '<span class="waiting-dot"></span>' : '×'}</span><div><span>${step.role === 'baseline' ? 'Measuring your current model' : 'Testing a cheaper model'}</span><strong>${escape(modelName(step.model))}${step.state === 'failed' ? ' — unavailable for comparison' : step.state === 'complete' ? ' — done' : ''}</strong></div></div>`).join('') || '<p class="mock-note">Preparing your benchmark…</p>'}</div>${hasError ? `<p class="form-error" role="alert">${escape(benchmarkError)}</p><p class="mock-note">Any calls already sent may be charged. We never retry automatically.</p>` : '<p class="mock-note">Same request. Same instructions. You make the quality call.</p>'}<button class="text-button muted" data-action="edit">${hasError ? 'Edit request and try again' : 'Cancel and edit request'}</button></main>`;
}

function costComparison(candidate) {
  return `<div class="cost-comparison" aria-label="Per-request costs"><div><span>Current</span><strong>${escape(modelName(benchmark.baseline.model))}</strong><p>${cents(benchmark.baseline.cost)} <small>/ request</small></p></div><span class="cost-arrow" aria-hidden="true">${arrow}</span><div class="optimized-cost"><span>Suggested</span><strong>${escape(modelName(candidate.model))}</strong><p>${cents(candidate.cost)} <small>/ request</small></p></div></div>`;
}

function measurementDetails() {
  return `<p>Observed usage × published USD prices = estimated API cost for each sample call. Standard service tier; no Batch discounts, taxes, regional uplift, or custom pricing. Prices checked ${escape(benchmark.pricing.checkedAt)}. <a href="${escape(benchmark.pricing.source)}" target="_blank" rel="noreferrer">Official pricing</a>.</p><div class="measurement-list">${benchmark.measured.map(call => `<div class="measurement-row"><strong>${escape(modelName(call.model))}</strong><span>${preciseDollars(call.cost)} · ${(call.latencyMs / 1000).toFixed(2)}s</span><small>${call.usage.inputTokens.toLocaleString()} input · ${call.usage.cachedInputTokens.toLocaleString()} cached input${call.usage.cachedInputReported ? '' : ' (not reported; assumed 0)'} · ${call.usage.outputTokens.toLocaleString()} output tokens</small><small>Returned model: ${escape(call.returnedModel)}${call.complete ? '' : ' · Incomplete / excluded'}</small><small>Per 1M tokens: $${MODELS[call.model].input} input / $${MODELS[call.model].cached} cached / $${MODELS[call.model].output} output</small></div>`).join('')}</div><p>Measured benchmark total: ${preciseDollars(benchmark.measuredBenchmarkCost)}${benchmark.costMayBeIncomplete ? '. Failed calls may add charges not returned by OpenAI' : ''}. Conservative pre-run estimate: up to ${preciseDollars(benchmark.plan.maxCost)}. Each answer was capped at ${benchmark.plan.maxOutputTokens} output tokens; incomplete answers are excluded.</p>${benchmark.baseline.outputSource === 'pasted' ? `<p>Your pasted answer is shown for quality comparison. Baseline cost comes from a fresh replay, not the historical pasted answer.</p><details><summary>See the baseline answer we measured</summary><p class="preserve-lines">${escape(benchmark.baseline.output)}</p></details>` : ''}<p>Reduction = (baseline cost − accepted candidate cost) ÷ baseline cost. A single request can vary in length, caching, and output quality. No prompt rewriting or automated quality scoring was used.</p>`;
}

function failuresNote() {
  return benchmark.failures.length ? `<div class="benchmark-notice">${benchmark.failures.map(item => `<p>${escape(modelName(item.model))}: ${escape(item.message)}</p>`).join('')}</div>` : '';
}

function resultsPage() {
  const candidate = benchmark.candidates[candidateIndex];
  if (!candidate) {
    const failed = !benchmark.measured.some(item => item.model !== benchmark.baseline.model && item.complete);
    return `<main id="main" class="wrap results-page page-content">${steps(2)}<div class="reveal-heading"><h1 tabindex="-1">${failed ? 'No comparison yet.' : 'No cheaper result this time.'}</h1><p>${failed ? 'The alternatives could not complete this benchmark.' : 'Your current model may be worth the extra cost for this request.'}</p></div>${failuresNote()}<section class="quality-decision"><p>${failed ? 'Check the messages below, or try another request.' : 'The completed alternatives cost as much or more. We have no savings to recommend.'}</p><button class="button secondary" data-action="edit">Try another request ${arrow}</button></section><details class="method-details"><summary>How we calculated this <span class="chevron"></span></summary>${measurementDetails()}</details></main>`;
  }
  return `<main id="main" class="wrap results-page page-content">${steps(2)}<div class="reveal-heading"><p class="mock-note">${exhausted ? 'You passed on these alternatives' : 'Measured on your sample'}</p><h1 tabindex="-1">${exhausted ? 'Keep your standards.' : `<span>${reductionLabel(candidate.reduction)}%</span> cheaper.`}</h1><p>${exhausted ? 'Your current model may be worth the extra cost for this request.' : 'Same request. Smaller model. You decide on quality.'}</p></div>${costComparison(candidate)}
    <section class="comparison-section" aria-label="Compare outputs"><div class="output-grid"><article class="output-card"><div class="output-header"><span>${benchmark.baseline.outputSource === 'pasted' ? 'Your original output' : 'Current model output'}</span><small>${escape(modelName(benchmark.baseline.model))}</small></div><div class="output-text">${escape(benchmark.baseline.displayOutput)}</div></article><article class="output-card optimized-output"><div class="output-header"><span>Cheaper model output</span><small>${escape(modelName(candidate.model))}</small></div><div class="output-text">${escape(candidate.output)}</div></article></div><p class="comparison-note">${benchmark.baseline.outputSource === 'pasted' ? 'Original output supplied by you; current cost measured on a fresh replay. ' : ''}Both models received the same request and instructions. Lower cost does not establish equivalent quality.</p></section>
    <section class="quality-decision" aria-live="polite">${exhausted ? `<h2>No change recommended.</h2><p>You rejected every cheaper output. That's a useful result, too.</p><div class="revisit-options">${benchmark.candidates.map((option, i) => `<button class="small-button" data-action="revisit" data-index="${i}">Revisit ${escape(modelName(option.model))}</button>`).join('')}</div><button class="text-button" data-action="edit">Try another request ${arrow}</button>` : `<h2>Would you ship this output?</h2><p>Your standards. Your call.</p><div class="decision-buttons"><button class="button primary" data-action="accept">${check} Yes, this works</button><button class="button secondary" data-action="try-next">No, try another ${arrow}</button></div>`}</section>${failuresNote()}
    <details class="method-details"><summary>How we calculated this <span class="chevron" aria-hidden="true"></span></summary><p>Only the model changed. Candidates are ordered by measured sample cost. You decide which answers are acceptable.</p>${measurementDetails()}</details><div class="page-back"><button class="text-button muted" data-action="edit">Edit my request</button></div></main>`;
}

function savingsPage() {
  const candidate = benchmark.candidates[acceptedIndex];
  return `<main id="main" class="wrap savings-page page-content"><section class="savings-reveal"><span class="success-seal" aria-hidden="true">${check}</span><p class="eyebrow">More money in your pocket</p><h1 tabindex="-1">~${dollars(estimate.monthly)}<small>/month</small></h1><p class="annual-savings">~${dollars(estimate.annual)}<span>/year</span></p><p class="potential-label">estimated savings opportunity</p><span class="workflow-savings">${down} ${reductionLabel(candidate.reduction)}% cheaper on this sample</span></section>
    <p class="savings-assumption">Based on one sample, your monthly bill, and your usage estimate. Future savings are not guaranteed.</p>${costComparison(candidate)}
    <section class="take-savings"><div class="take-heading"><h2>Take the savings.</h2><p>Change this workflow from ${escape(modelName(submitted.model))} to ${escape(modelName(candidate.model))}. Keep your prompt as it is.</p></div><div class="setup-model"><span class="tiny-label">MODEL</span><code>${escape(candidate.model)}</code></div><div class="setup-prompt"><span class="tiny-label">YOUR ORIGINAL INSTRUCTIONS</span><pre>${escape(submitted.system || 'No system instructions supplied.')}</pre></div><button class="button primary full-width" data-action="copy" data-copy="setup">Copy suggested setup ${arrow}</button><div class="copy-options"><button data-action="copy" data-copy="model">Copy model</button><span aria-hidden="true">·</span><button data-action="copy" data-copy="cursor">Copy for Cursor</button><span aria-hidden="true">·</span><button data-action="copy" data-copy="codex">Copy for Codex</button></div><p id="copy-status" class="copy-status" role="status"></p><div id="copy-fallback"></div></section>
    <details class="method-details"><summary>How we estimated this <span class="chevron" aria-hidden="true"></span></summary><p>${dollars(estimate.monthlySpend)} monthly bill × ${percent(estimate.share)}% workflow share × ${(candidate.reduction * 100).toFixed(2)}% lower sample cost. Annual savings use the unrounded monthly estimate × 12.</p><p>“A little” = 25%, “About half” = 50%, and “Most of it” = 75% of your bill. We treat your usage choice as a spending share. This assumes a similar request mix, volume, and pricing, and that the alternative works for comparable requests.</p><p>You accepted one sample output. This is an estimated savings opportunity, not validated production savings. Test more representative requests before changing your app.</p>${measurementDetails()}</details><div class="final-actions"><button class="text-button" data-action="edit-estimate">Adjust my estimate</button><button class="text-button" data-action="edit">Try another request ${arrow}</button></div></main>`;
}

function route() {
  const name = location.hash.slice(1);
  return ['input', 'analysis', 'results', 'estimate', 'savings'].includes(name) ? name : 'home';
}

function guardedPage() {
  let page = route();
  if (['analysis', 'results', 'estimate', 'savings'].includes(page) && !submitted) page = 'input';
  else if (['results', 'estimate', 'savings'].includes(page) && !benchmark) page = 'analysis';
  else if (['estimate', 'savings'].includes(page) && acceptedIndex === null) page = 'results';
  else if (page === 'savings' && !estimate) page = 'estimate';
  if (page !== route()) history.replaceState(null, '', `#${page}`);
  return page;
}

function render(focus = false) {
  const page = guardedPage();
  document.title = `${({ home: 'Cut your AI bill', input: 'One request', analysis: 'Challenge accepted', results: 'A cheaper way', estimate: 'What could you save?', savings: 'Take the savings' })[page]} — AI Bill Doctor`;
  root.innerHTML = header(page) + ({ home: landing, input: inputPage, analysis: analysisPage, results: resultsPage, estimate: estimatePage, savings: savingsPage })[page]() + footer();
  if (focus) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.querySelector('h1')?.focus({ preventScroll: true });
  }
}

function navigate(page) {
  if (location.hash === `#${page}`) handleNavigation();
  else location.hash = page;
}

function clearKeyField() {
  const field = document.querySelector('#apiKey');
  if (field) field.value = '';
}

async function startAnalysis() {
  if (preflightController || activeController) return;
  const controller = new AbortController();
  preflightController = controller;
  const snapshot = structuredClone(input);
  const signature = JSON.stringify(snapshot);
  const approvedMaxCost = confirmation?.signature === signature && document.querySelector('#approve-budget')?.checked ? confirmation.maxCost : undefined;
  const button = document.querySelector('#run-button');
  button.disabled = true;
  button.textContent = 'Checking benchmark cost…';
  try {
    const response = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: snapshot }), signal: controller.signal, cache: 'no-store' });
    if ([404, 405].includes(response.status)) throw new Error('Restart your local server with node server.mjs, then reload this page.');
    const plan = await response.json();
    if (!response.ok) throw new Error(plan.error?.message || 'Could not prepare this benchmark.');
    if (route() !== 'input' || signature !== JSON.stringify(input)) return;
    if (plan.requiresConfirmation && !(approvedMaxCost >= plan.maxCost)) {
      confirmation = { signature, maxCost: plan.maxCost };
      document.querySelector('#budget-confirmation').innerHTML = `<p>This example could cost up to <strong>$${plan.maxCost.toFixed(4)}</strong> to benchmark, above the $${plan.budgetUsd.toFixed(2)} local budget.</p><label><input id="approve-budget" type="checkbox"> I approve up to $${plan.maxCost.toFixed(4)} for this benchmark.</label>`;
      return;
    }
    let apiKey = document.querySelector('#apiKey').value.trim();
    if (!apiKey) throw new Error('Enter your OpenAI API key.');
    clearKeyField();
    submitted = snapshot;
    benchmark = null;
    benchmarkError = '';
    candidateIndex = 0;
    acceptedIndex = null;
    estimate = null;
    exhausted = false;
    spending = { monthlySpend: '', share: '' };
    progressEvents = plan.calls.map((call, index) => ({ ...call, index, state: 'waiting' }));
    activeController = controller;
    navigate('analysis');
    // No key in application state, DOM markup, URL, storage, logs, or results.
    // Drop the browser reference immediately after fetch consumes the body.
    const pending = fetch('/api/benchmark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: snapshot, apiKey, approvedMaxCost }), signal: controller.signal, cache: 'no-store' });
    apiKey = '';
    const stream = await pending;
    if (!stream.ok) {
      const result = await stream.json();
      throw new Error(result.error?.message || 'The benchmark could not start.');
    }
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let receivedResult = false;
    const processLine = line => {
      if (!line.trim() || controller.signal.aborted) return;
      const event = JSON.parse(line);
      if (event.type === 'progress') {
        progressEvents[event.index] = event;
        if (route() === 'analysis') render();
      } else if (event.type === 'error') throw new Error(event.error.message);
      else if (event.type === 'result') { benchmark = event.result; receivedResult = true; }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(processLine);
    }
    buffer += decoder.decode();
    if (buffer) processLine(buffer);
    if (!receivedResult) throw new Error('The connection ended before results arrived. A call already sent may still be charged.');
    if (!controller.signal.aborted) {
      activeController = null;
      navigate('results');
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    if (activeController === controller) {
      benchmarkError = error.message || 'The benchmark could not finish. Please try again.';
      controller.abort();
      render(true);
    } else {
      const errorField = document.querySelector('#form-error');
      if (errorField) errorField.textContent = error instanceof TypeError ? 'Could not reach the local benchmark server. Restart it and reload this page.' : error.message || 'Could not reach the local server. Restart it and reload.';
    }
  } finally {
    if (preflightController === controller) preflightController = null;
    if (activeController === controller) activeController = null;
    if (button.isConnected) { button.disabled = false; button.innerHTML = `Find a cheaper way ${arrow}`; }
  }
}

function tryNextCandidate() {
  if (route() !== 'results' || !benchmark?.candidates.length) return;
  acceptedIndex = null;
  estimate = null;
  if (candidateIndex >= benchmark.candidates.length - 1) exhausted = true;
  else candidateIndex += 1;
  render(true);
}

function acceptCandidate() {
  if (exhausted || route() !== 'results' || !benchmark?.candidates[candidateIndex]) return;
  acceptedIndex = candidateIndex;
  estimate = null;
  navigate('estimate');
}

function saveEstimate() {
  if (acceptedIndex === null) return;
  const candidate = benchmark.candidates[acceptedIndex];
  estimate = calculateSavings(Number(spending.monthlySpend), spending.share, benchmark.baseline.cost, candidate.cost);
  navigate('savings');
}

function handleNavigation() {
  const page = guardedPage();
  if (page !== 'analysis' && activeController) {
    activeController.abort();
    activeController = null;
    submitted = null;
    benchmark = null;
  }
  if (page !== 'input' && page !== 'analysis' && preflightController) preflightController.abort();
  confirmation = null;
  clearKeyField();
  render(true);
}

function rememberField(event) {
  const field = event.target;
  const form = field.closest('form');
  if (!form) return;
  field.setCustomValidity?.('');
  if (form.id === 'request-form' && Object.hasOwn(input, field.name)) {
    input[field.name] = field.value;
    confirmation = null;
    const panel = document.querySelector('#budget-confirmation');
    if (panel) panel.innerHTML = '';
  } else if (form.id === 'spending-form' && Object.hasOwn(spending, field.name)) spending[field.name] = field.value;
  const error = document.querySelector('#form-error');
  if (error) error.textContent = '';
}
root.addEventListener('input', rememberField);
root.addEventListener('change', rememberField);

root.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  for (const field of form.querySelectorAll('[required]')) {
    if (field.type !== 'radio' && !field.value.trim()) field.setCustomValidity('Please fill out this field.');
  }
  const invalid = form.querySelector(':invalid');
  if (invalid) {
    document.querySelector('#form-error').textContent = form.id === 'request-form' ? 'Choose your model, paste one request, and enter your API key.' : 'Enter your monthly bill and choose how much usage looks like this.';
    invalid.focus();
    form.reportValidity();
    return;
  }
  if (form.id === 'request-form') void startAnalysis();
  else if (form.id === 'spending-form') saveEstimate();
});

root.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'demo') { input = structuredClone(DEMO_INPUT); navigate('input'); }
  else if (action === 'edit') navigate('input');
  else if (action === 'accept') acceptCandidate();
  else if (action === 'try-next') tryNextCandidate();
  else if (action === 'back-to-output') navigate('results');
  else if (action === 'edit-estimate') navigate('estimate');
  else if (action === 'revisit') {
    const index = Number(button.dataset.index);
    if (!Number.isInteger(index) || !benchmark?.candidates[index]) return;
    candidateIndex = index;
    acceptedIndex = null;
    estimate = null;
    exhausted = false;
    render(true);
  } else if (action === 'copy' && acceptedIndex !== null) {
    const candidate = benchmark.candidates[acceptedIndex];
    const text = makeSetup(submitted, candidate, button.dataset.copy);
    const status = document.querySelector('#copy-status');
    const fallback = document.querySelector('#copy-fallback');
    try {
      await navigator.clipboard.writeText(text);
      if (status?.isConnected) status.textContent = 'Copied. Try it on a few more requests before switching.';
      if (fallback?.isConnected) fallback.innerHTML = '';
    } catch {
      if (status?.isConnected) status.textContent = 'Your browser blocked clipboard access. Copy the selected text below.';
      if (fallback?.isConnected) {
        fallback.innerHTML = `<label class="sr-only" for="manual-copy">Suggested setup to copy</label><textarea id="manual-copy" readonly rows="6">${escape(text)}</textarea>`;
        const field = document.querySelector('#manual-copy'); field.focus(); field.select();
      }
    }
  }
});

window.addEventListener('hashchange', handleNavigation);
window.addEventListener('pagehide', () => {
  activeController?.abort();
  preflightController?.abort();
  clearKeyField();
  input = blankInput();
  submitted = benchmark = estimate = null;
  acceptedIndex = null;
});
window.addEventListener('pageshow', event => { clearKeyField(); if (event.persisted) render(); });
render();
