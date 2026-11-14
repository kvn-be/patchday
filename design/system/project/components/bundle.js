/* @ds-bundle: {"format":4,"namespace":"Patchday","components":[{"name":"Button"},{"name":"Glass"},{"name":"Ground"},{"name":"ListRow"},{"name":"Pill"},{"name":"ProgressBar"},{"name":"Segmented"},{"name":"Sidebar"},{"name":"Switch"},{"name":"Steps"},{"name":"WeekDial"},{"name":"Wheel"}]} */
(function () {
  // Components are plain CSS classes from bundle.css. Only the dial needs a script.
  function mountWeekDial(dial, slider, options) {
  var NS = 'http://www.w3.org/2000/svg', C = 300;
  var opt = options || {}, hour0 = opt.hour === undefined ? 147 : opt.hour;
  var DAYS = opt.days || ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var SHORT = opt.short || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    function add(tag, attrs) { var el = document.createElementNS(NS, tag); for (var k in attrs) el.setAttribute(k, attrs[k]); dial.appendChild(el); return el; }
  function polar(hour, r) { var a = hour / 168 * 2 * Math.PI - Math.PI / 2; return [C + r * Math.cos(a), C + r * Math.sin(a)]; }
  add('circle', { cx: C, cy: C, r: 298, 'class': 'glow' });
  add('circle', { cx: C, cy: C, r: 282, 'class': 'ring' });
  add('circle', { cx: C, cy: C, r: 196, 'class': 'inner' });
  var ticks = [];
  for (var h = 0; h < 168; h++) {
    var start = h % 24 === 0, a = polar(h, start ? 250 : 262), b = polar(h, 274);
    ticks.push(add('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], 'class': start ? 'tick day-start' : 'tick' }));
  }
  for (var d = 0; d < 7; d++) {
    var p = polar(d * 24, 204), q = polar(d * 24 + 6, 204);
    add('path', { d: 'M' + p[0] + ' ' + p[1] + 'A204 204 0 0 1 ' + q[0] + ' ' + q[1], 'class': 'night' });
  }
  var labels = SHORT.map(function (label, i) {
    var p = polar(i * 24 + 12, 232), t = add('text', { x: p[0], y: p[1], 'class': 'day' });
    t.textContent = label; return t;
  });
  var dayText = add('text', { x: C, y: 250, 'class': 'sub' });
  var timeText = add('text', { x: C, y: 345, 'class': 'big' });
  var hand = add('line', { 'class': 'hand' }), dot = add('circle', { r: 7, 'class': 'pin' });
  function paint(hour) {
    var a = polar(hour, 196), b = polar(hour, 262), c = polar(hour, 268), day = Math.floor(hour / 24);
    hand.setAttribute('x1', a[0]); hand.setAttribute('y1', a[1]); hand.setAttribute('x2', b[0]); hand.setAttribute('y2', b[1]);
    dot.setAttribute('cx', c[0]); dot.setAttribute('cy', c[1]);
    dayText.textContent = DAYS[day];
    timeText.textContent = String(hour % 24).padStart(2, '0') + ':00';
    labels.forEach(function (l, i) { l.classList.toggle('on', i === day); });
    ticks.forEach(function (t, i) { t.classList.toggle('past', i >= day * 24 && i <= hour); });
  }
  function fromPointer(e) {
    var box = dial.getBoundingClientRect();
    var turn = (Math.atan2(e.clientY - box.top - box.height / 2, e.clientX - box.left - box.width / 2) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
    var hour = Math.round(turn / (2 * Math.PI) * 168) % 168;
    slider.value = hour; paint(hour); if (opt.onChange) opt.onChange(hour);
  }
  var dragging = false;
  dial.addEventListener('pointerdown', function (e) { dragging = true; dial.setPointerCapture(e.pointerId); fromPointer(e); });
  dial.addEventListener('pointermove', function (e) { if (dragging) fromPointer(e); });
  dial.addEventListener('pointerup', function () { dragging = false; });
  slider.addEventListener('input', function () { paint(Number(slider.value)); if (opt.onChange) opt.onChange(Number(slider.value)); });
  paint(hour0);
  return { paint: paint };
  }
  // The colored ground drifts against the pointer; glass above it stays still. Nothing follows the pointer itself.
  function startParallax(root) {
    var target = root || document.documentElement;
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return function () {};
    var frame = 0, x = 0, y = 0;
    function apply() { frame = 0; target.style.setProperty('--px', x.toFixed(3)); target.style.setProperty('--py', y.toFixed(3)); }
    function queue() { if (!frame) frame = requestAnimationFrame(apply); }
    function move(event) { x = (event.clientX / window.innerWidth) * 2 - 1; y = (event.clientY / window.innerHeight) * 2 - 1; queue(); }
    function rest() { x = 0; y = 0; queue(); }
    window.addEventListener('pointermove', move);
    document.documentElement.addEventListener('pointerleave', rest);
    return function stop() { window.removeEventListener('pointermove', move); document.documentElement.removeEventListener('pointerleave', rest); rest(); };
  }
  // A drum of choices: the chosen one sits in the band in the middle, its neighbours tilt away and fade.
  // items: [{ value, label }]. Returns { set(value, animate), get() }.
  function mountWheel(root, options) {
    var opt = options || {}, items = opt.items || [], ROW = opt.rowHeight || 44;
    var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    var list = document.createElement('div');
    list.className = 'pd-wheel-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('tabindex', '0');
    if (opt.label) list.setAttribute('aria-label', opt.label);
    var id = 'pd-wheel-' + Math.random().toString(36).slice(2, 8);
    var nodes = items.map(function (item, i) {
      var node = document.createElement('div');
      node.className = 'pd-wheel-item';
      node.id = id + '-' + i;
      node.setAttribute('role', 'option');
      node.textContent = item.label;
      node.addEventListener('click', function () { go(i, true); });
      list.appendChild(node);
      return node;
    });
    root.classList.add('pd-wheel');
    root.style.setProperty('--pd-row', ROW + 'px');
    root.appendChild(list);

    var index = Math.max(0, indexOf(opt.value));
    var frame = 0, settle = 0, lastSent = index, placed = false;
    function indexOf(value) { for (var i = 0; i < items.length; i++) if (items[i].value === value) return i; return -1; }
    // A wheel mounted inside a hidden page has no height yet; it takes its place once it shows.
    function place() {
      if (!list.clientHeight) return;
      list.scrollTop = index * ROW;
      placed = true;
      paint();
    }
    function paint() {
      frame = 0;
      if (!placed) return;
      var center = list.scrollTop / ROW;
      nodes.forEach(function (node, i) {
        var d = i - center, far = Math.min(Math.abs(d), 3);
        node.style.opacity = String(Math.max(0, 1 - far * 0.3));
        node.style.transform = still ? '' : 'rotateX(' + (-d * 18).toFixed(1) + 'deg) scale(' + (1 - far * 0.06).toFixed(3) + ')';
      });
      var nearest = Math.max(0, Math.min(items.length - 1, Math.round(center)));
      if (nearest !== index) { index = nearest; mark(); }
    }
    function mark() {
      nodes.forEach(function (node, i) { node.setAttribute('aria-selected', String(i === index)); });
      list.setAttribute('aria-activedescendant', nodes[index] ? nodes[index].id : '');
    }
    function commit() {
      settle = 0;
      if (!placed) return;
      // Snap exactly onto the row, then report once.
      if (Math.abs(list.scrollTop - index * ROW) > 1) list.scrollTo({ top: index * ROW, behavior: still ? 'auto' : 'smooth' });
      if (index !== lastSent) { lastSent = index; if (opt.onChange) opt.onChange(items[index].value); }
    }
    function go(i, animate) {
      index = Math.max(0, Math.min(items.length - 1, i));
      mark();
      if (!placed) return;
      list.scrollTo({ top: index * ROW, behavior: animate && !still ? 'smooth' : 'auto' });
      clearTimeout(settle);
      settle = setTimeout(commit, animate && !still ? 380 : 0);
    }
    list.addEventListener('scroll', function () {
      if (!placed) return;
      if (!frame) frame = requestAnimationFrame(paint);
      clearTimeout(settle);
      settle = setTimeout(commit, 140);
    });
    list.addEventListener('keydown', function (event) {
      var step = { ArrowDown: 1, ArrowUp: -1, PageDown: 3, PageUp: -3 }[event.key];
      if (step) { event.preventDefault(); go(index + step, true); }
      else if (event.key === 'Home') { event.preventDefault(); go(0, true); }
      else if (event.key === 'End') { event.preventDefault(); go(items.length - 1, true); }
    });
    mark();
    if (window.ResizeObserver) new ResizeObserver(function () { if (!placed || !settle) place(); }).observe(list);
    requestAnimationFrame(place);
    return {
      set: function (value, animate) { var i = indexOf(value); if (i >= 0 && i !== index) { lastSent = i; go(i, animate); } },
      get: function () { return items[index] ? items[index].value : undefined; },
    };
  }
  // Phases of one update as hubs and bars. set(current, state): current is the index of the running
  // phase (-1 before it starts, steps - 1 when finished), state is 'running', 'done' or 'failed'.
  function mountSteps(root, options) {
    var NS = 'http://www.w3.org/2000/svg', opt = options || {}, n = Math.max(2, opt.steps || 4), GAP = 60;
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'pd-steps');
    svg.setAttribute('viewBox', '0 0 ' + ((n - 1) * GAP + 24) + ' 24');
    svg.setAttribute('width', String(((n - 1) * GAP + 24) * (opt.scale || 0.7)));
    svg.setAttribute('role', 'img');
    function el(tag, attrs) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); svg.appendChild(e); return e; }
    var parts = [];
    for (var i = 0; i < n; i++) {
      var x = 12 + i * GAP, part = {};
      part.dot = el('circle', { 'class': 'dot', cx: x, cy: 12 });
      if (i < n - 1) el('line', { 'class': 'bar', x1: x + 10, y1: 12, x2: x + 50, y2: 12 });
      part.hub = el('circle', { 'class': 'hub', cx: x, cy: 12 });
      if (i < n - 1) part.bar = el('line', { 'class': 'bar-fill', x1: x + 10, y1: 12, x2: x + 50, y2: 12 });
      part.fill = el('circle', { 'class': 'hub-fill', cx: x, cy: 12, r: 10, transform: 'rotate(180,' + x + ',12)' });
      parts.push(part);
    }
    root.appendChild(svg);
    function set(current, state, label) {
      svg.classList.toggle('is-done', state === 'done');
      if (label) svg.setAttribute('aria-label', label);
      parts.forEach(function (part, i) {
        var reached = state === 'done' ? true : i <= current;
        part.dot.classList.toggle('done', reached);
        part.hub.classList.toggle('done', reached);
        part.fill.classList.toggle('done', reached);
        var failing = state === 'failed' && i === Math.max(0, current);
        part.fill.classList.toggle('fail', failing);
        part.dot.classList.toggle('fail', failing);
        if (part.bar) {
          var full = state === 'done' || i < current;
          var active = !full && state === 'running' && i === current;
          part.bar.classList.toggle('full', full);
          part.bar.classList.toggle('active', active);
          // A CSS animation starts over whenever the element is put back into the page, as a list
          // does when it redraws. A negative delay resumes it at the time it has really been running.
          if (active && part.since === undefined) part.since = Date.now();
          if (!active) part.since = undefined;
          part.bar.style.animationDelay = active ? -(Date.now() - part.since) + 'ms' : '';
        }
      });
    }
    set(opt.current === undefined ? -1 : opt.current, opt.state || 'running', opt.label);
    return { element: svg, set: set };
  }
  window.Patchday = { mountWeekDial: mountWeekDial, startParallax: startParallax, mountWheel: mountWheel, mountSteps: mountSteps };
})();
