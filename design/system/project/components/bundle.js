/* @ds-bundle: {"format":4,"namespace":"Patchday","components":[{"name":"AppHeader"},{"name":"Badge"},{"name":"Button"},{"name":"CommandField"},{"name":"LanguageSwitch"},{"name":"ProgressBar"},{"name":"ReportWindow"},{"name":"WeekDial"}]} */
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
  window.Patchday = { mountWeekDial: mountWeekDial };
})();
