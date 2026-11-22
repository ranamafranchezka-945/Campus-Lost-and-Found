/* ══════════════════════════════════════════════════════════════════════════════
   Back2You — Quick Report Assistant (report-assistant.js)

   A student describes the item in their own words, in English or Filipino, by typing
   or by speaking. Each message is sent to POST /api/items/assistant/parse, which
   returns a draft report plus any possible matches already on file. This script
   fills the real report form from that draft, so nothing is submitted until the
   student reviews it and presses Submit Report as usual.

   Draft state lives here only. Follow-up messages are merged field by field: a new
   value replaces an old one only when the server is at least as confident about it,
   so answering "at the library" never overwrites the item name.

   Loaded after home-page.js, which defines categoryIconHtml(), updateTypeRadio()
   and showToast().
   ══════════════════════════════════════════════════════════════════════════════ */

(function () {
  const MAX_MESSAGE = 1000;
  const MAX_DESC = 500;

  // Field -> the form control the draft fills, for the "filled in" chips and highlights.
  const FIELD_LABELS = {
    type: 'Report type',
    title: 'Item name',
    category: 'Category',
    location: 'Campus location',
    locationDetails: 'Specific spot',
    when: 'When',
    desc: 'Description'
  };

  const state = {
    draft: { type: '', title: '', category: '', location: '', locationDetails: '', desc: '', when: '' },
    confidence: {},
    turns: 0,
    busy: false,
    engine: 'rules',
    recognition: null,
    listening: false,
    // Which field the assistant's last question was about ('desc' when it just asked
    // "Can you describe it..."), so the very next reply can be taken as a direct answer
    // to that question even without the usual "description is ..." cue.
    pendingField: ''
  };

  function el(id) {
    return document.getElementById(id);
  }

  function escape(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function iconFor(category) {
    if (typeof window.categoryIconHtml === 'function') {
      return window.categoryIconHtml(category, 'assistant-chip-icon');
    }
    return '';
  }

  function notify(message, isError) {
    if (typeof window.showToast === 'function') window.showToast(message, Boolean(isError));
  }

  /* ── Chat log ─────────────────────────────────────────────────────────────── */

  function addBubble(role, html) {
    const log = el('assistantLog');
    if (!log) return null;
    const row = document.createElement('div');
    row.className = `assistant-msg assistant-msg--${role}`;
    row.innerHTML = html;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  function addThinking() {
    return addBubble('bot', '<span class="assistant-typing" aria-label="Reading your message"><i></i><i></i><i></i></span>');
  }

  function friendlyWhen(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('en-PH', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
    });
  }

  function chipHtml(field, value, uncertain) {
    const display = field === 'when' ? friendlyWhen(value)
      : field === 'type' ? (value === 'lost' ? 'Lost item' : 'Found item')
      : value;
    if (!display) return '';
    const icon = field === 'category' ? iconFor(value) : '';
    return `<span class="assistant-chip${uncertain ? ' assistant-chip--guess' : ''}">
      ${icon}<small>${escape(FIELD_LABELS[field] || field)}</small>${escape(display)}
    </span>`;
  }

  function matchCardHtml(item) {
    const photo = item.photo
      ? `<img src="${escape(item.photo)}" alt="" class="assistant-match-photo" loading="lazy" />`
      : '<span class="assistant-match-photo assistant-match-photo--empty" aria-hidden="true"></span>';
    return `<a class="assistant-match" href="#items" data-action="assistantOpenMatch" data-args='${window.actionArgs(item.id)}'>
      ${photo}
      <span class="assistant-match-body">
        <strong>${escape(item.title)}</strong>
        <small>${escape(item.location || 'Location not stated')} · ${escape(item.refCode || '')}</small>
      </span>
      <span class="assistant-match-go" aria-hidden="true">View</span>
    </a>`;
  }

  /* ── Draft merging ────────────────────────────────────────────────────────── */

  // A later message only wins a field when the server is at least as sure about it.
  // Keeps "near the library" from clearing an item name extracted a turn earlier.
  //
  // The description is never the whole narration: it only comes from the server's
  // cue-gated extraction (the words after an explicit "description is ..."), except when
  // the assistant's own last question specifically asked for a description - then the
  // whole reply is naturally the answer, same as a person would read it.
  function mergeDraft(incoming, confidence, rawMessage, answeringDescQuestion) {
    const changed = [];
    for (const field of ['type', 'title', 'category', 'location', 'locationDetails', 'when']) {
      const value = String(incoming[field] || '').trim();
      if (!value) continue;
      const nextConfidence = Number(confidence[field] || 0);
      const currentConfidence = Number(state.confidence[field] || 0);
      const current = String(state.draft[field] || '').trim();
      if (current && nextConfidence < currentConfidence) continue;
      if (current === value) continue;
      state.draft[field] = value;
      state.confidence[field] = nextConfidence;
      changed.push(field);
    }

    // Follow-ups are appended rather than replaced - the first bit said is usually the
    // most descriptive one.
    const addition = (answeringDescQuestion ? String(rawMessage || '') : String(incoming.desc || '')).trim();
    if (addition) {
      const existing = String(state.draft.desc || '').trim();
      if (!existing) {
        state.draft.desc = addition.slice(0, MAX_DESC);
        changed.push('desc');
      } else if (!existing.toLowerCase().includes(addition.toLowerCase())) {
        const combined = `${existing} ${addition}`.trim();
        if (combined.length <= MAX_DESC) {
          state.draft.desc = combined;
          changed.push('desc');
        }
      }
    }

    return changed;
  }

  /* ── Filling the real form ────────────────────────────────────────────────── */

  function flash(node) {
    if (!node) return;
    const target = node.closest('.input-field') || node;
    target.classList.remove('assistant-filled');
    // Restart the animation even when the same field is filled twice in a row.
    void target.offsetWidth;
    target.classList.add('assistant-filled');
    setTimeout(() => target.classList.remove('assistant-filled'), 1800);
  }

  function setCategoryField(value) {
    const field = el('itemCategory');
    const picker = el('itemCategoryPicker');
    if (!field || !picker) return null;
    field.value = value;
    picker.innerHTML = `${iconFor(value).replace('assistant-chip-icon', 'category-picker-selected-icon')}${escape(value)}`;
    picker.classList.add('selected');
    return picker;
  }

  // Applies whatever the draft currently holds to the form controls, and returns the
  // fields it actually changed so the chat can report them.
  function applyDraft(changed) {
    const applied = [];

    if (changed.includes('type') && state.draft.type) {
      const radio = document.querySelector(`input[name="itemType"][value="${state.draft.type}"]`);
      if (radio) {
        radio.checked = true;
        if (typeof window.updateTypeRadio === 'function') window.updateTypeRadio();
        flash(document.querySelector('.report-type-selection'));
        applied.push('type');
      }
    }

    if (changed.includes('title') && state.draft.title) {
      const input = el('itemTitle');
      if (input) {
        input.value = state.draft.title;
        flash(input);
        applied.push('title');
      }
    }

    if (changed.includes('category') && state.draft.category) {
      const picker = setCategoryField(state.draft.category);
      if (picker) {
        flash(picker);
        applied.push('category');
      }
    }

    if (changed.includes('location') && state.draft.location) {
      const select = el('itemLocation');
      if (select) {
        const option = [...select.options].find(entry => entry.value === state.draft.location);
        if (option) {
          select.value = option.value;
          // The form renders this select through a styled button; keep the two in sync.
          select.dispatchEvent(new Event('change', { bubbles: true }));
          flash(select);
          applied.push('location');
        }
      }
    }

    if (changed.includes('locationDetails') && state.draft.locationDetails) {
      const input = el('itemLocationDetails');
      if (input) {
        input.value = state.draft.locationDetails;
        const fold = el('reportMoreDetails');
        if (fold) fold.open = true;
        flash(input);
        applied.push('locationDetails');
      }
    }

    if (changed.includes('desc') && state.draft.desc) {
      const textarea = el('itemDesc');
      if (textarea) {
        textarea.value = state.draft.desc;
        flash(textarea);
        applied.push('desc');
      }
    }

    return applied;
  }

  /* ── Talking back ─────────────────────────────────────────────────────────── */

  function summaryHtml(applied, uncertain, question, matches) {
    const chips = applied
      .filter(field => field !== 'desc')
      .map(field => chipHtml(field, state.draft[field], uncertain.includes(field)))
      .filter(Boolean)
      .join('');

    const parts = [];

    if (chips) {
      const count = applied.filter(field => field !== 'desc').length;
      parts.push(`<p>Filled in ${count} ${count === 1 ? 'field' : 'fields'} for you:</p>`);
      parts.push(`<div class="assistant-chips">${chips}</div>`);
    } else if (!question) {
      parts.push('<p>I could not pull anything new out of that. Try naming the item and where it was.</p>');
    }

    if (uncertain.length) {
      const names = uncertain.map(field => (FIELD_LABELS[field] || field).toLowerCase());
      parts.push(`<p class="assistant-note">I guessed the ${names.join(' and ')}. Please check ${uncertain.length === 1 ? 'it' : 'them'} before submitting.</p>`);
    }

    if (question) {
      parts.push(`<p class="assistant-ask">${escape(question)}</p>`);
    } else if (chips) {
      parts.push('<p class="assistant-note">Review the form below, add a photo if you have one, then press <strong>Submit Report</strong>.</p>');
    }

    if (matches.length) {
      parts.push(`<div class="assistant-matches">
        <p class="assistant-matches-head">${matches.length === 1 ? 'A report already on file may match this:' : `${matches.length} reports already on file may match this:`}</p>
        ${matches.map(matchCardHtml).join('')}
      </div>`);
    }

    return parts.join('');
  }

  /* ── Sending ──────────────────────────────────────────────────────────────── */

  async function send(message) {
    const text = String(message || '').trim().slice(0, MAX_MESSAGE);
    if (!text || state.busy) return;

    state.busy = true;
    const button = el('assistantSendBtn');
    if (button) button.disabled = true;

    addBubble('user', `<p>${escape(text)}</p>`);
    const input = el('assistantInput');
    if (input) input.value = '';
    const thinking = addThinking();

    try {
      const response = await fetch('/api/items/assistant/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      });
      const data = await response.json().catch(() => ({}));
      if (thinking) thinking.remove();

      if (!response.ok || !data.success) {
        addBubble('bot', `<p>${escape(data.message || 'I could not read that. Please fill in the form directly.')}</p>`);
        return;
      }

      state.engine = data.engine || 'rules';
      state.turns += 1;

      const changed = mergeDraft(data.draft || {}, data.confidence || {}, text, state.pendingField === 'desc');
      state.pendingField = (data.missing && data.missing[0]) || '';
      // The form starts folded away; reveal it before filling anything in, so the
      // student can see the fields light up instead of finding them already filled.
      if (changed.length && typeof window.openManualReportForm === 'function') window.openManualReportForm();
      const applied = applyDraft(changed);
      const uncertain = (data.uncertain || []).filter(field => applied.includes(field));
      addBubble('bot', summaryHtml(applied, uncertain, data.question || '', data.matches || []));

      if (applied.length) {
        const form = el('itemForm');
        if (form && state.turns === 1) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch (error) {
      if (thinking) thinking.remove();
      addBubble('bot', '<p>I could not reach the server. Please fill in the form directly.</p>');
    } finally {
      state.busy = false;
      if (button) button.disabled = false;
      const field = el('assistantInput');
      if (field) field.focus();
    }
  }

  /* ── Voice input (Web Speech API, where the browser supports it) ──────────── */

  function speechSupport() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function stopListening() {
    state.listening = false;
    const mic = el('assistantMicBtn');
    if (mic) {
      mic.classList.remove('listening');
      mic.setAttribute('aria-label', 'Dictate your report');
      mic.setAttribute('aria-pressed', 'false');
    }
  }

  function startListening() {
    const Recognition = speechSupport();
    const input = el('assistantInput');
    const mic = el('assistantMicBtn');
    if (!Recognition || !input) return;

    const recognition = new Recognition();
    state.recognition = recognition;
    recognition.lang = 'en-PH';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = event => {
      let transcript = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        transcript += event.results[index][0].transcript;
      }
      input.value = transcript.trim().slice(0, MAX_MESSAGE);
    };
    recognition.onerror = event => {
      stopListening();
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        // Three different causes produce this one error code, so name the likely one:
        // an insecure origin, a page-level Permissions-Policy, or a denied prompt.
        notify(window.isSecureContext
          ? 'Microphone access was blocked by the browser. Check the site permissions, or type your report instead.'
          : 'Dictation needs a secure connection (https:// or localhost). Type your report instead.', true);
      } else if (event.error === 'network') {
        // Chrome's speech recognition runs in the cloud, so dictation alone needs the network.
        notify('Dictation needs an internet connection. Typing still works offline.', true);
      } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
        notify('Dictation stopped. You can type your report instead.', true);
      }
    };
    recognition.onend = () => {
      stopListening();
      const value = input.value.trim();
      // Speaking a full sentence is the whole point, so send it without a second tap.
      if (value) send(value);
    };

    try {
      recognition.start();
      state.listening = true;
      if (mic) {
        mic.classList.add('listening');
        mic.setAttribute('aria-label', 'Stop dictating');
        mic.setAttribute('aria-pressed', 'true');
      }
    } catch (error) {
      stopListening();
    }
  }

  /* ── Public actions, called through data-action in index.html ─────────────── */

  window.assistantSubmit = function assistantSubmit(event) {
    if (event) event.preventDefault();
    const input = el('assistantInput');
    if (!input) return;
    const value = input.value.trim();
    if (!value) {
      notify('Describe the item first, for example "I lost my black AquaFlask near the library".', true);
      return;
    }
    send(value);
  };

  window.assistantUseExample = function assistantUseExample(text) {
    const input = el('assistantInput');
    if (!input) return;
    input.value = text;
    send(text);
  };

  window.assistantToggleVoice = function assistantToggleVoice() {
    if (state.listening && state.recognition) {
      state.recognition.stop();
      return;
    }
    startListening();
  };

  window.assistantOpenMatch = function assistantOpenMatch(id) {
    // Reuse the listing's own detail view when it is available on this page.
    if (typeof window.openItemDetails === 'function') {
      window.openItemDetails(id);
      return;
    }
    const items = el('items');
    if (items) items.scrollIntoView({ behavior: 'smooth' });
  };

  window.assistantReset = function assistantReset() {
    state.draft = { type: '', title: '', category: '', location: '', locationDetails: '', desc: '', when: '' };
    state.confidence = {};
    state.turns = 0;
    state.pendingField = '';
    const log = el('assistantLog');
    if (log) log.innerHTML = '';
    const input = el('assistantInput');
    if (input) input.value = '';
    greet();
  };

  /* ── Start-up ─────────────────────────────────────────────────────────────── */

  function greet() {
    addBubble('bot', [
      '<p>Tell me what happened in your own words — English or Filipino, typed or spoken.</p>',
      '<p class="assistant-note">I will fill in the report form below. Nothing is submitted until you press Submit Report.</p>'
    ].join(''));
  }

  function init() {
    const card = el('reportAssistant');
    if (!card) return;

    // Hide the mic where the browser has no speech recognition (Firefox, most in-app
    // browsers) rather than offering a button that silently does nothing.
    const mic = el('assistantMicBtn');
    if (mic && !speechSupport()) mic.hidden = true;

    const input = el('assistantInput');
    if (input) {
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          window.assistantSubmit(event);
        }
      });
    }

    greet();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
