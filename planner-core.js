/* Moteur de planification — fonctions pures, partagées par la page et le script d'initialisation. */
(function (root) {
  const pad = n => String(n).padStart(2, '0');
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const toHM = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  const parse = d => { const [y, mo, da] = d.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, da)); };
  const fmt = dt => dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
  const addDays = (d, n) => { const x = parse(d); x.setUTCDate(x.getUTCDate() + n); return fmt(x); };
  const dow = d => (parse(d).getUTCDay() + 6) % 7; // 0 = lundi
  const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
  const round15 = m => Math.ceil(m / 15) * 15;

  const CODES = {
    ENT: { label: 'Entreprise', kind: 'work' },
    ECO: { label: 'École', kind: 'school' },
    CON: { label: 'Congé', kind: 'off' },
    RU: { label: 'Congé (RU)', kind: 'off' },
    RP: { label: 'Repos', kind: 'off' },
    F: { label: 'Férié', kind: 'off' },
    LIB: { label: 'Libre', kind: 'off' },
    WE: { label: 'Week-end', kind: 'weekend' },
    NA: { label: 'Non renseigné', kind: 'unknown' }
  };

  function dayCode(cfg, d) {
    if (cfg.days && cfg.days[d]) return cfg.days[d];
    if (dow(d) >= 5) return 'WE';
    const r = cfg.calendarRange || {};
    if (r.from && r.to && d >= r.from && d <= r.to) return 'ENT';
    return 'NA';
  }

  function examOn(cfg, d) {
    return (cfg.exams || []).find(e => d >= e.start && d <= (e.end || e.start)) || null;
  }

  /* Blocs fixes calculés : travail, cours, trajets, sommeil. Jamais stockés. */
  function fixedBlocks(cfg, d) {
    const code = dayCode(cfg, d);
    const out = [];
    const add = (cat, title, s, e, extra) => { if (e > s) out.push(Object.assign({ id: 'fx-' + d + '-' + out.length, fixed: true, date: d, cat, title, start: toHM(s), end: toHM(e) }, extra || {})); };
    const c = cfg.commute || {};
    const ov = (cfg.dayHours && cfg.dayHours[d]) || null;
    if (code === 'ENT') {
      const wh = ov || cfg.work;
      const s = toMin(wh.start), e = toMin(wh.end), t = +c.work || 0;
      add('trajet', 'Trajet → travail', s - t, s);
      add('travail', 'Alternance — SNCF Réseau', s, e);
      add('trajet', 'Trajet → maison', e, e + t);
    } else if (code === 'ECO') {
      const sh = ov || cfg.school;
      const s = toMin(sh.start), e = toMin(sh.end), t = +c.school || 0;
      const ex = examOn(cfg, d);
      add('trajet', 'Trajet → école', s - t, s);
      add('cours', ex ? ex.name : 'Cours — BTS SIO', s, e, ex ? { exam: true } : null);
      add('trajet', 'Trajet → maison', e, e + t);
    }
    if (cfg.sleep && cfg.sleep.enabled) {
      const b = toMin(cfg.sleep.bed), w = toMin(cfg.sleep.wake);
      add('sommeil', 'Sommeil', 0, w);
      add('sommeil', 'Sommeil', b, 24 * 60);
    }
    return out;
  }

  /* Fin de la journée contrainte (retour maison) */
  function homeAt(cfg, d) {
    const code = dayCode(cfg, d), c = cfg.commute || {};
    const ov = (cfg.dayHours && cfg.dayHours[d]) || null;
    if (code === 'ENT') return toMin((ov || cfg.work).end) + (+c.work || 0);
    if (code === 'ECO') return toMin((ov || cfg.school).end) + (+c.school || 0);
    return null;
  }

  /* Créneaux de révision candidats pour un jour */
  function revisionWindows(cfg, d) {
    const R = cfg.rev, code = dayCode(cfg, d), wd = dow(d);
    const latest = toMin(R.latest);
    const res = [];
    if (examOn(cfg, d)) return res;
    if (code === 'ENT' || code === 'ECO') {
      if (code === 'ECO' && wd === 4 && R.fridayOff) return res;
      const dur = code === 'ENT' ? +R.workEveningMin : +R.schoolEveningMin;
      if (!dur) return res;
      const start = Math.max(toMin(R.eveningStart), round15(homeAt(cfg, d) + (+R.breakAfterMin || 0)));
      if (start + dur <= latest) res.push([start, start + dur]);
    } else if (code === 'WE') {
      (wd === 5 ? R.saturday : R.sunday).forEach(([a, b]) => res.push([toMin(a), toMin(b)]));
    } else if (CODES[code] && CODES[code].kind === 'off') {
      if (code === 'F' && R.holidayOff) return res;
      R.freeDay.forEach(([a, b]) => res.push([toMin(a), toMin(b)]));
    }
    return res.map(([a, b]) => [a, Math.min(b, latest)]).filter(([a, b]) => b - a >= 25);
  }

  const overlaps = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;

  function busyOn(cfg, events, d, ignoreId) {
    const list = fixedBlocks(cfg, d).filter(b => b.cat !== 'sommeil').map(b => [toMin(b.start), toMin(b.end)]);
    events.forEach(e => { if (e.date === d && e.id !== ignoreId && !e.allDay) list.push([toMin(e.start), toMin(e.end)]); });
    return list;
  }

  function isFree(cfg, events, d, s, e, ignoreId) {
    if (cfg.sleep && cfg.sleep.enabled) {
      if (s < toMin(cfg.sleep.wake) || e > toMin(cfg.sleep.bed)) return false;
    }
    return !busyOn(cfg, events, d, ignoreId).some(([a, b]) => overlaps(s, e, a, b));
  }

  function revMinutesOn(events, d, ignoreId) {
    return events.filter(e => e.date === d && e.cat === 'revision' && e.id !== ignoreId).reduce((t, e) => t + toMin(e.end) - toMin(e.start), 0);
  }

  /* Trouve le prochain créneau libre pour replacer une séance */
  function findNextSlot(cfg, events, fromDate, durMin, opts) {
    opts = opts || {};
    const lastDate = opts.until || addDays(fromDate, 21);
    for (let d = fromDate; d <= lastDate; d = addDays(d, 1)) {
      if (opts.skipDate && d === opts.skipDate) continue;
      if (revMinutesOn(events, d, opts.ignoreId) + durMin > +cfg.rev.maxDayMin) continue;
      if (opts.subject && events.some(e => e.date === d && e.subject === opts.subject && e.id !== opts.ignoreId && e.cat === 'revision')) continue;
      const wins = revisionWindows(cfg, d);
      for (const [a, b] of wins) {
        for (let s = a; s + durMin <= Math.max(b, a + durMin) && s + durMin <= toMin(cfg.rev.latest); s += 15) {
          if (opts.notBefore && d === opts.notBefore.date && s < opts.notBefore.min) continue;
          if (isFree(cfg, events, d, s, s + durMin, opts.ignoreId)) return { date: d, start: toHM(s), end: toHM(s + durMin) };
        }
      }
    }
    return null;
  }

  const RTYPES = {
    learn: { label: 'Apprentissage + fiche', min: 45, long: true },
    practice: { label: 'Exercices pratiques', min: 45, long: true },
    recall: { label: 'Mémorisation — rappel actif', min: 25, long: false },
    recall2: { label: 'Rappel espacé (J+7)', min: 25, long: false },
    mock: { label: 'Entraînement type examen', min: 75, long: true }
  };

  /* Génère le plan de révision. Conserve les séances faites, verrouillées ou passées. */
  function generatePlan(cfg, events, fromDate, uid) {
    uid = uid || (() => 'r' + Math.random().toString(36).slice(2, 10));
    const target = (cfg.exams || []).filter(e => e.start > fromDate).sort((a, b) => a.start < b.start ? -1 : 1)[0];
    if (!target) return { events: events.slice(), added: [], removed: [], unplanned: [] };
    const endDate = addDays(target.start, -1);
    const keep = events.filter(e => !(e.cat === 'revision' && e.auto && !e.done && !e.locked && e.date >= fromDate));
    const removed = events.filter(e => !keep.includes(e));
    const doneKey = new Set(keep.filter(e => e.cat === 'revision' && e.subject).map(e => e.subject + '|' + e.chapter + '|' + e.rtype));
    const lastLearn = {};
    keep.forEach(e => { if (e.rtype === 'learn') lastLearn[e.subject + '|' + e.chapter] = e.date; });

    // Tâches
    const tasks = [];
    const daysLeft = Math.max(1, diffDays(fromDate, target.start));
    (cfg.subjects || []).forEach(s => {
      if (s.inExam === false) return;
      const w = (+s.coef || 1) * (6 - (+s.level || 3));
      (s.chapters || []).forEach((ch, i) => {
        const k = s.id + '|' + ch;
        const order = i * 0.08;
        if (!doneKey.has(k + '|learn')) tasks.push({ subject: s.id, chapter: ch, rtype: 'learn', score: w * (1.25 - order), dep: null });
        if (s.practice && !doneKey.has(k + '|practice')) tasks.push({ subject: s.id, chapter: ch, rtype: 'practice', score: w * (1.0 - order), dep: { rtype: 'learn', gap: 1 } });
        if (!doneKey.has(k + '|recall')) tasks.push({ subject: s.id, chapter: ch, rtype: 'recall', score: w * 1.1, dep: { rtype: 'learn', gap: 2 } });
        if (!doneKey.has(k + '|recall2')) tasks.push({ subject: s.id, chapter: ch, rtype: 'recall2', score: w * 0.9, dep: { rtype: 'learn', gap: 6 } });
      });
      if (!doneKey.has(s.id + '|Sujet type|mock')) tasks.push({ subject: s.id, chapter: 'Sujet type', rtype: 'mock', score: w * 1.4, window: 9 });
    });

    // Créneaux
    const slots = [];
    for (let d = fromDate; d <= endDate; d = addDays(d, 1)) {
      revisionWindows(cfg, d).forEach(([a, b]) => slots.push({ date: d, a, b }));
    }
    const placed = keep.slice();
    const added = [];
    const learnDate = Object.assign({}, lastLearn);
    const count = {};
    keep.forEach(e => { if (e.cat === 'revision' && e.subject && e.date >= addDays(fromDate, -7)) count[e.subject] = (count[e.subject] || 0) + 1; });
    const subjectsById = Object.fromEntries((cfg.subjects || []).map(s => [s.id, s]));

    for (const sl of slots) {
      const len = sl.b - sl.a;
      if (revMinutesOn(placed, sl.date) + len > +cfg.rev.maxDayMin) continue;
      if (!isFree(cfg, placed, sl.date, sl.a, sl.b)) continue;
      const toEnd = diffDays(sl.date, target.start);
      let best = null, bestScore = -1;
      for (const t of tasks) {
        if (t.used) continue;
        const rt = RTYPES[t.rtype];
        if (len < rt.min) continue;
        if (t.window && toEnd > t.window) continue;
        if (placed.some(e => e.date === sl.date && e.subject === t.subject && e.cat === 'revision')) continue;
        let sc = t.score;
        if (t.dep) {
          const ld = learnDate[t.subject + '|' + t.chapter];
          if (!ld || diffDays(ld, sl.date) < t.dep.gap) continue;
          sc *= 1 + Math.min(1, (diffDays(ld, sl.date) - t.dep.gap) * 0.25);
        }
        sc /= 1 + 0.55 * (count[t.subject] || 0);
        if (rt.long && len < 60) sc *= 0.6;
        if (!rt.long && len >= 75) sc *= 0.5;
        if (t.rtype === 'mock') sc *= 1 + (9 - toEnd) * 0.15;
        if (t.rtype === 'learn' && toEnd < 4) sc *= 0.5;
        if (sc > bestScore) { bestScore = sc; best = t; }
      }
      if (!best) continue;
      best.used = true;
      const s = subjectsById[best.subject];
      const ev = { id: uid(), date: sl.date, start: toHM(sl.a), end: toHM(sl.b), cat: 'revision', auto: true, done: false, subject: best.subject, chapter: best.chapter, rtype: best.rtype, title: (s ? s.code + ' ' + s.short : best.subject) + ' — ' + RTYPES[best.rtype].label };
      placed.push(ev); added.push(ev);
      count[best.subject] = (count[best.subject] || 0) + 1;
      if (best.rtype === 'learn') learnDate[best.subject + '|' + best.chapter] = sl.date;
    }
    const unplanned = tasks.filter(t => !t.used && (t.rtype === 'learn' || t.rtype === 'mock')).map(t => ({ subject: t.subject, chapter: t.chapter, rtype: t.rtype }));
    return { events: placed, added, removed, unplanned, target };
  }

  const api = { pad, toMin, toHM, parse, fmt, addDays, dow, diffDays, CODES, RTYPES, dayCode, examOn, fixedBlocks, revisionWindows, isFree, findNextSlot, generatePlan, revMinutesOn, homeAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PlannerCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
