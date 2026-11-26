const workspace = document.querySelector('#workspace');
const dialog = document.querySelector('#editor');
const notice = document.querySelector('#notice');
const statuses = {
  pending: 'Pending', confirmed: 'Confirmed', 'checked-in': 'Checked in',
  'checked-out': 'Checked out', cancelled: 'Cancelled',
};
const sections = {
  overview: 'Overview', availability: 'Availability', reservations: 'Reservations',
  arrivals: 'Arrivals', inventory: 'Rooms & rates',
};
const moneyFormat = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortDateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const longDateFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});
const dateObject = (value) => new Date(`${value}T00:00:00Z`);
const shortDate = (value) => shortDateFormat.format(dateObject(value));
const longDate = (value) => longDateFormat.format(dateObject(value));
const money = (value) => value == null ? '—' : `${moneyFormat.format(value)} MAD`;
const plural = (count, word) => `${count} ${word}${Number(count) === 1 ? '' : 's'}`;
const e = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

let currentPage = 0;
let noticeTimeout;
let today;

function nextDate(value) {
  const date = dateObject(value);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function setToday(value) {
  today = value;
  const time = document.querySelector('#business-date');
  time.dateTime = today;
  time.textContent = longDate(today);
}

async function api(path, body) {
  const response = await fetch(`/api${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'The request failed.');
  return data;
}

function notify(message) {
  clearTimeout(noticeTimeout);
  notice.textContent = message;
  notice.hidden = false;
  noticeTimeout = setTimeout(() => { notice.hidden = true; }, 4500);
}

function errorElement() {
  return '<p class="form-error" role="alert" hidden></p>';
}

function formError(form, message = '') {
  const target = form.querySelector('[role="alert"]');
  target.textContent = message;
  target.hidden = !message;
}

function submit(form, onSubmit) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    formError(form);
    try {
      await onSubmit(Object.fromEntries(new FormData(form)));
    } catch (error) {
      formError(form, error.message);
    } finally {
      button.disabled = false;
    }
  });
}

const buttonLink = (href, text, variation = '') =>
  `<a class="button ${variation}" href="${e(href)}">${e(text)}</a>`;
const secondary = (href, text) => buttonLink(href, text, 'button-secondary');
const empty = (message) => `<p class="empty">${e(message)}</p>`;
const bookingHref = (id) => `#reservation/${id}`;
const badge = (status) => `<span class="badge badge-${e(status)}">${e(statuses[status])}</span>`;
const option = (value, text, selected) =>
  `<option value="${e(value)}"${String(value) === String(selected) ? ' selected' : ''}>${e(text)}</option>`;

function heading(title, subtitle, action = '') {
  return `<div class="page-heading"><div><h1>${e(title)}</h1>${subtitle ? `<p>${e(subtitle)}</p>` : ''}</div>${action}</div>`;
}

function field(label, name, attributes = '') {
  return `<label>${e(label)}<input name="${name}" ${attributes}></label>`;
}

function table(columns, body) {
  return `<div class="table-wrap"><table><thead><tr>
    ${columns.map(([label, style]) => `<th scope="col" class="${style ?? ''}">${e(label)}</th>`).join('')}
    </tr></thead><tbody>${body}</tbody></table></div>`;
}

function bookingsTable(bookings) {
  if (!bookings.length) return empty('No reservations match these filters.');
  return table([['Lead guest'], ['Stay'], ['Rooms'], ['Status'], ['Balance', 'numeric']],
    bookings.map((book) => `<tr>
      <td><a class="text-link table-primary" href="${bookingHref(book.res_id)}">${e(book.guest_name)}</a>
        <span class="muted small">#${book.res_id} · ${e(book.channel)}</span></td>
      <td class="nowrap">${shortDate(book.check_in_date)} – ${shortDate(book.check_out_date)}</td>
      <td>${e(book.room_numbers)}</td><td>${badge(book.status)}</td>
      <td class="numeric">${money(book.balance_due_mad)}</td>
    </tr>`).join(''));
}

function arrivalList(arrivals) {
  if (!arrivals.length) return empty('No confirmed arrivals for this date.');
  return `<ul class="arrival-list">${arrivals.map((arrival) => `<li>
    <a class="arrival-name" href="${bookingHref(arrival.res_id)}">${e(arrival.guest_name)}</a>
    <p>${e(arrival.rooms)}</p>
    <p>${Number(arrival.balance_due_mad) > 0 ? `Due ${money(arrival.balance_due_mad)}` : 'Paid in full'}</p>
    </li>`).join('')}</ul>`;
}

function overviewPage(stats, bookings, arrivals) {
  const metric = (label, value, detail, href, primary = false) =>
    `<a class="metric${primary ? ' metric-primary' : ''}" href="${href}">
      <span>${label}</span><strong>${value}</strong><small>${detail}</small>
    </a>`;

  return heading('Reception dashboard', 'Room availability, arrivals, and bookings at Riad Safir.',
    buttonLink('#new', '+ New reservation')) +
    `<div class="section-stack">
      <div class="metric-grid">
        ${metric('Rooms free tonight', stats.available, `of ${stats.total_rooms} physical rooms`, '#availability', true)}
        ${metric('Expected today', stats.arrivals, 'Confirmed arrivals', '#arrivals')}
        ${metric('In-house stays', stats.in_house, 'Checked-in reservations', '#reservations?status=checked-in')}
        ${metric('Pending bookings', stats.pending, 'Requests awaiting confirmation', '#reservations?status=pending')}
      </div>
      <div class="split">
        <section class="panel">
          <div class="panel-heading"><h2>Reservation board</h2><a class="text-link" href="#reservations">All reservations</a></div>
          ${bookingsTable(bookings.slice(0, 5))}
        </section>
        <section class="panel">
          <div class="panel-heading"><h2>Today’s arrivals</h2><a class="text-link" href="#arrivals">View arrivals</a></div>
          ${arrivalList(arrivals)}
        </section>
      </div>
    </div>`;
}

function typeOptions(catalog, allTypes = false) {
  return (allTypes ? option('', 'All room types') : '') +
    (catalog.room_types ?? []).map((type) => option(type.room_type_id, type.type_name)).join('');
}

function availabilityPage(catalog) {
  return heading('Room availability', 'Find rooms that are free for every night of the requested stay.') +
    `<section class="panel">
      <div class="panel-heading"><h2>Search a stay</h2></div>
      <form id="availability-form" class="toolbar">
        ${field('Check-in', 'check_in', `type="date" value="${today}" required`)}
        ${field('Check-out', 'check_out', `type="date" min="${nextDate(today)}" value="${nextDate(today)}" required`)}
        <label>Room type<select name="type">${typeOptions(catalog, true)}</select></label>
        <button class="button" type="submit">Find rooms</button>
        <div class="span-all">${errorElement()}</div>
      </form>
      <div id="availability-results" aria-live="polite"></div>
    </section>`;
}

function availabilityResults(rooms, dates) {
  if (!rooms.length) return empty('No rooms are available for the whole stay.');
  return `<div class="panel-heading"><h2>${plural(rooms.length, 'room')} available</h2>
      <span class="muted small">${shortDate(dates.check_in)} – ${shortDate(dates.check_out)}</span></div>` +
    table([['Room'], ['Room type'], ['Capacity'], ['Nightly rate', 'numeric'], ['']], rooms.map((room) => {
      const params = new URLSearchParams({ in: dates.check_in, out: dates.check_out, room: room.room_id });
      return `<tr><td><strong>${e(room.room_no)}</strong> ${e(room.room_name)}</td>
        <td>${e(room.type_name)}</td><td>${plural(room.max_occupancy, 'guest')}</td>
        <td class="numeric">${money(room.nightly_rate_mad)}</td>
        <td>${room.nightly_rate_mad == null || dates.check_in < today ? '—' : secondary(`#new?${params}`, 'Select room')}</td></tr>`;
    }).join(''));
}

function attachDates(form, startName, endName) {
  const start = form.elements.namedItem(startName);
  const end = form.elements.namedItem(endName);
  start.addEventListener('change', () => {
    if (!start.value) return;
    end.min = nextDate(start.value);
    if (end.value < end.min) end.value = end.min;
  });
}

function reservationsPage(bookings, params) {
  return heading('Reservations', 'Find a booking by lead guest, reservation number, or status.',
    buttonLink('#new', '+ New reservation')) +
    `<section class="panel">
      <form id="booking-search" class="toolbar search">
        ${field('Lead guest or booking number', 'q', `type="search" placeholder="Search reservations" value="${e(params.get('q'))}"`)}
        <label>Status<select name="status">${option('', 'All statuses', params.get('status'))}
          ${Object.entries(statuses).map(([key, value]) => option(key, value, params.get('status'))).join('')}</select></label>
        <button class="button" type="submit">Search</button>${secondary('#reservations', 'Clear filters')}
        ${errorElement()}
      </form>
      ${bookingsTable(bookings)}
    </section>`;
}

function arrivalsPage(arrivals, date) {
  return heading('Expected arrivals', 'Confirmed bookings still due to check in on the selected date.') +
    `<section class="panel">
      <form id="arrival-search" class="toolbar">
        ${field('Arrival date', 'date', `type="date" value="${e(date)}" required`)}
        <button class="button" type="submit">View arrivals</button>${secondary('#arrivals', 'Today')}
        ${errorElement()}
      </form>
      ${arrivals.length ? table([['Lead guest'], ['Allocated rooms'], ['Check-out'], ['Balance', 'numeric']],
        arrivals.map((item) => `<tr><td><a class="text-link" href="${bookingHref(item.res_id)}">${e(item.guest_name)}</a></td>
          <td>${e(item.rooms)}</td><td>${shortDate(item.check_out_date)}</td>
          <td class="numeric">${money(item.balance_due_mad)}</td></tr>`).join('')) : empty('No confirmed arrivals for this date.')}
    </section>`;
}

function roomLine(catalog, selected = '') {
  return `<div class="room-line">
    <label>Physical room<select name="room_id" required>
      ${option('', 'Select a room', selected)}
      ${(catalog.rooms ?? []).map((room) => {
        const type = catalog.room_types.find((entry) => entry.room_type_id === room.room_type_id);
        return option(room.room_id, `${room.room_no} · ${room.room_name ?? type.type_name}`, selected);
      }).join('')}
    </select></label>
    ${field('Guests', 'num_guests', 'type="number" min="1" step="1" value="1" required')}
    <button class="button button-secondary" type="button" data-remove-room>Remove</button>
    <p class="room-info"></p>
  </div>`;
}

function newBookingPage(catalog, guests, params) {
  const validDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(dateObject(value).valueOf());
  const requestedIn = params.get('in');
  const requestedOut = params.get('out');
  const checkIn = validDay(requestedIn) && requestedIn >= today ? requestedIn : today;
  const checkOut = validDay(requestedOut) && requestedOut > checkIn ? requestedOut : nextDate(checkIn);
  return heading('New reservation', 'Add a lead guest and the rooms for one shared stay.', secondary('#reservations', 'Back to reservations')) +
    `<form id="new-booking" class="panel form-card">
      <div class="form-section">
        <div class="inline-heading"><h2>Lead guest</h2>
          <button class="button button-secondary" type="button" data-add-guest>Register guest</button></div>
        <label>Guest<select name="guest_id" required>${option('', 'Select a guest')}
          ${guests.map((guest) => option(guest.guest_id, `${guest.last_name}, ${guest.first_name}`)).join('')}
        </select></label>
      </div>
      <div class="form-section">
        <h2>Stay details</h2>
        <div class="fields">
          ${field('Check-in', 'check_in_date', `type="date" min="${today}" value="${e(checkIn)}" required`)}
          ${field('Check-out', 'check_out_date', `type="date" min="${e(nextDate(checkIn))}" value="${e(checkOut)}" required`)}
          <label>Booking channel<select name="channel" required>
            ${['Direct', 'Booking.com', 'Phone', 'Email', 'Other'].map((channel) => option(channel, channel)).join('')}
          </select></label>
          <label class="span-all">Special requests <em>Optional</em><textarea name="special_requests"></textarea></label>
        </div>
      </div>
      <div class="form-section">
        <div class="inline-heading"><h2>Room allocation</h2>
          <button type="button" class="button button-secondary" data-add-room>+ Add room</button></div>
        <div id="room-lines">${roomLine(catalog, params.get('room') ?? '')}</div>
        <p class="muted small">Adding a pending reservation does not hold rooms. Availability is checked again during confirmation.</p>
      </div>
      <div class="panel-body">
        ${errorElement()}
        <button class="button" type="submit">Create pending reservation</button>
      </div>
    </form>`;
}

function editDialog(title, fields, action, onSubmit) {
  dialog.innerHTML = `<div class="panel-heading"><h2 id="dialog-title">${e(title)}</h2></div>
    <form class="panel-body"><div class="fields">${fields}</div>${errorElement()}
    <div class="form-footer">
      <button type="submit" class="button">${e(action)}</button>
      <button type="button" class="button button-secondary" data-dismiss>Close</button>
    </div></form>`;
  const form = dialog.querySelector('form');
  form.querySelector('[data-dismiss]').addEventListener('click', () => dialog.close());
  submit(form, async (values) => {
    await onSubmit(values, form);
    dialog.close();
  });
  dialog.showModal();
  return form;
}

function registerGuest(select) {
  editDialog('Register guest',
    field('First name', 'first_name', 'required maxlength="80"') + field('Last name', 'last_name', 'required maxlength="80"') +
    field('Email (optional)', 'email', 'type="email" maxlength="254"') + field('Phone (optional)', 'phone', 'type="tel" maxlength="40"') +
    field('Nationality (optional)', 'nationality', 'maxlength="80"') + field('ID document number (optional)', 'id_doc_number', 'maxlength="40"'),
    'Save guest', async (guest) => {
      const { guest_id } = await api('/guests', guest);
      select.add(new Option(`${guest.last_name.trim()}, ${guest.first_name.trim()}`, guest_id, true, true));
      notify('Guest registered.');
    });
}

function bindNewBooking(catalog) {
  const form = document.querySelector('#new-booking');
  const lines = form.querySelector('#room-lines');

  function refreshLine(line) {
    const select = line.querySelector('[name="room_id"]');
    const room = catalog.rooms?.find((entry) => String(entry.room_id) === select.value);
    const type = room && catalog.room_types.find((entry) => entry.room_type_id === room.room_type_id);
    const occupants = line.querySelector('[name="num_guests"]');
    occupants.max = type?.max_occupancy ?? '';
    line.querySelector('.room-info').textContent = type
      ? `${type.type_name} · Up to ${plural(type.max_occupancy, 'guest')} · ${type.current_rate == null ? 'No effective rate today' : `${money(type.current_rate)} per night`}` : '';
  }

  function refreshLines() {
    const all = Array.from(lines.children);
    for (const line of all) {
      line.querySelector('[data-remove-room]').hidden = all.length === 1;
      refreshLine(line);
    }
  }

  attachDates(form, 'check_in_date', 'check_out_date');
  refreshLines();
  form.querySelector('[data-add-guest]').addEventListener('click', () => registerGuest(form.elements.namedItem('guest_id')));
  form.querySelector('[data-add-room]').addEventListener('click', () => {
    lines.insertAdjacentHTML('beforeend', roomLine(catalog));
    refreshLines();
    lines.lastElementChild.querySelector('select').focus();
  });
  lines.addEventListener('change', (event) => {
    if (event.target.name === 'room_id') refreshLine(event.target.closest('.room-line'));
  });
  lines.addEventListener('click', (event) => {
    if (!event.target.matches('[data-remove-room]') || lines.children.length < 2) return;
    event.target.closest('.room-line').remove();
    refreshLines();
  });
  submit(form, async (values) => {
    const rooms = Array.from(lines.children, (line) => ({
      room_id: line.querySelector('[name="room_id"]').value,
      num_guests: line.querySelector('[name="num_guests"]').value,
    }));
    if (new Set(rooms.map((room) => room.room_id)).size !== rooms.length) throw new Error('Select each room once per reservation.');
    const { res_id } = await api('/reservations', { ...values, rooms });
    location.hash = bookingHref(res_id);
    notify(`Reservation #${res_id} created.`);
  });
}

function paymentLabel(receipt) {
  if (receipt.payment_method === 'CARD') return `${receipt.card_brand} · •••• ${receipt.card_last4} · ${receipt.auth_code}`;
  if (receipt.payment_method === 'CASH') return `${moneyFormat.format(receipt.amount_in_currency)} ${receipt.currency_code} · ${receipt.receipt_no}`;
  return `${receipt.bank_name} · ${receipt.transfer_ref}`;
}

const paymentOpen = (status) => status !== 'cancelled' && status !== 'checked-out';
const statusActions = {
  pending: [['confirmed', 'Confirm reservation'], ['cancelled', 'Cancel reservation']],
  confirmed: [['checked-in', 'Check in'], ['cancelled', 'Cancel reservation']],
  'checked-in': [['checked-out', 'Check out']],
};

function detailPage(booking) {
  const actions = statusActions[booking.status] ?? [];
  return heading(`Reservation #${booking.res_id}`, booking.guest_name, secondary('#reservations', 'All reservations')) +
    `<div class="detail-grid">
      <div class="detail-main">
        <section class="panel panel-body">
          <div class="inline-heading"><h2>Stay details</h2>${badge(booking.status)}</div>
          <dl class="key-values">
            <div><dt>Check-in</dt><dd>${shortDate(booking.check_in_date)}</dd></div>
            <div><dt>Check-out</dt><dd>${shortDate(booking.check_out_date)}</dd></div>
            <div><dt>Length of stay</dt><dd>${plural(booking.nights, 'night')}</dd></div>
            <div><dt>Booking date</dt><dd>${shortDate(booking.booking_date)}</dd></div>
            <div><dt>Booking channel</dt><dd>${e(booking.channel)}</dd></div>
            <div><dt>Guest contact</dt><dd>${e(booking.email || booking.phone || '—')}</dd></div>
          </dl>
          ${booking.special_requests ? `<p class="remarks"><strong>Special requests</strong><br>${e(booking.special_requests)}</p>` : ''}
          ${actions.length ? `<form id="status-form" class="form-footer">
            <div class="action-row">${actions.map(([status, label]) => `<button class="button ${status === 'cancelled' ? 'button-danger' : ''}" type="button" data-status="${status}">${label}</button>`).join('')}</div>
            ${errorElement()}</form>` : ''}
        </section>
        <section class="panel">
          <div class="panel-heading"><h2>Allocated rooms</h2></div>
          ${table([['Room'], ['Room type'], ['Guests'], ['Agreed nightly rate', 'numeric']], booking.rooms.map((room) => `<tr>
            <td><strong>${e(room.room_no)}</strong> ${e(room.room_name)}</td>
            <td>${e(room.type_name)}</td><td>${room.num_guests}</td>
            <td class="numeric">${money(room.agreed_rate_mad)}</td>
          </tr>`).join(''))}
        </section>
        <section class="panel">
          <div class="panel-heading"><h2>Payment history</h2>
            ${paymentOpen(booking.status) ? '<button class="button button-secondary" type="button" data-payment>+ Record payment</button>' : ''}
          </div>
          ${booking.payments?.length ? table([['Date'], ['Method'], ['Amount', 'numeric']], booking.payments.map((receipt) => `<tr>
            <td class="nowrap">${shortDate(receipt.payment_date)}</td>
            <td><span class="table-primary">${e({ CARD: 'Card', CASH: 'Cash', TRANSFER: 'Bank transfer' }[receipt.payment_method])}</span>
              <span class="muted small">${e(paymentLabel(receipt))}</span></td>
            <td class="numeric">${money(receipt.amount_mad)}</td>
          </tr>`).join('')) : empty('No payments recorded.')}
        </section>
      </div>
      <aside class="panel panel-body">
        <h2>Booking balance</h2>
        <dl class="balance">
          <div><dt>Accommodation</dt><dd>${money(booking.charge_mad)}</dd></div>
          <div><dt>Deposit required (30%)</dt><dd>${money(booking.deposit_required_mad)}</dd></div>
          <div><dt>Received payments</dt><dd>${money(booking.paid_mad)}</dd></div>
          <div class="amount-due"><dt>Balance due</dt><dd>${money(booking.balance_due_mad)}</dd></div>
          ${Number(booking.credit_mad) > 0 ? `<div><dt>Credit</dt><dd>${money(booking.credit_mad)}</dd></div>` : ''}
        </dl>
        <p class="muted small">Remaining balance is due by check-in.</p>
      </aside>
    </div>`;
}

const amountAttributes = 'type="number" min="0.01" max="99999999.99" step="0.01" required';

function paymentDialog(booking) {
  const form = editDialog('Record received payment',
    field('Payment date', 'payment_date', `type="date" min="${booking.booking_date}" max="${today}" value="${today}" required`) +
    field('Amount booked in MAD', 'amount_mad', amountAttributes) +
    '<label class="span-all">Method<select name="payment_method"><option value="CASH">Cash</option><option value="CARD">Card</option><option value="TRANSFER">Bank transfer</option></select></label>' +
    '<div class="fields span-all" id="payment-method-fields"></div>',
    'Save payment', async (values) => {
      const { payment_method, payment_date, amount_mad, ...details } = values;
      if (payment_method === 'CASH' && details.currency_code === 'MAD') details.amount_in_currency = amount_mad;
      await api(`/reservations/${booking.res_id}/payments`, { payment_method, payment_date, amount_mad, details });
      notify('Payment recorded.');
      await render();
    });

  const method = form.elements.namedItem('payment_method');
  const area = form.querySelector('#payment-method-fields');
  function refreshCurrency() {
    const original = area.querySelector('[name="amount_in_currency"]');
    const isEuro = area.querySelector('[name="currency_code"]').value === 'EUR';
    original.required = isEuro;
    original.disabled = !isEuro;
    original.closest('label').hidden = !isEuro;
  }

  function refreshMethod() {
    if (method.value === 'CARD') {
      area.innerHTML = field('Card brand', 'card_brand', 'required maxlength="40" placeholder="Visa"') +
        field('Last four digits', 'card_last4', 'inputmode="numeric" pattern="[0-9]{4}" required maxlength="4"') +
        field('Authorization code', 'auth_code', 'required maxlength="40"');
    } else if (method.value === 'CASH') {
      area.innerHTML = '<label>Cash currency<select name="currency_code"><option>MAD</option><option>EUR</option></select></label>' +
        field('Amount received in EUR', 'amount_in_currency', amountAttributes) + field('Receipt number', 'receipt_no', 'required maxlength="40"');
      area.querySelector('[name="currency_code"]').addEventListener('change', refreshCurrency);
      refreshCurrency();
    } else {
      area.innerHTML = field('Bank name', 'bank_name', 'required maxlength="80"') +
        field('Transfer reference', 'transfer_ref', 'required maxlength="80"');
    }
  }
  method.addEventListener('change', refreshMethod);
  refreshMethod();
}

function bindDetail(booking) {
  workspace.querySelector('[data-payment]')?.addEventListener('click', () => paymentDialog(booking));
  const form = workspace.querySelector('#status-form');
  if (!form) return;
  form.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-status]');
    if (!button) return;
    const { status } = button.dataset;
    if (status === 'cancelled' && !window.confirm(`Cancel reservation #${booking.res_id}?`)) return;
    const buttons = form.querySelectorAll('button');
    buttons.forEach((control) => { control.disabled = true; });
    formError(form);
    try {
      await api(`/reservations/${booking.res_id}/status`, { status });
      notify(`Reservation ${statuses[status].toLowerCase()}.`);
      await render();
    } catch (error) {
      formError(form, error.message);
    } finally {
      buttons.forEach((control) => { control.disabled = false; });
    }
  });
}

function inventoryPage(catalog) {
  const controls = `<div class="action-row">
    <button type="button" class="button button-secondary" data-inventory="type">Add room type</button>
    <button type="button" class="button button-secondary" data-inventory="room">Add room</button>
    <button type="button" class="button" data-inventory="rate">Add rate</button></div>`;
  return heading('Rooms & rates', 'Physical rooms, occupancy limits, and the effective-dated price catalogue.', controls) +
    `<div class="directory">${(catalog.room_types ?? []).map((type) => {
      const rooms = catalog.rooms.filter((room) => room.room_type_id === type.room_type_id);
      const rates = catalog.rates.filter((rate) => rate.room_type_id === type.room_type_id);
      return `<section class="panel">
        <div class="panel-heading"><div><h2>${e(type.type_name)}</h2>
          <p>${e(type.bed_config)} · Up to ${plural(type.max_occupancy, 'guest')}</p></div>
          <strong>${money(type.current_rate)}${type.current_rate == null ? '' : ' / night'}</strong></div>
        ${table([['Room'], ['Floor']], rooms.map((room) => `<tr><td><strong>${e(room.room_no)}</strong> ${e(room.room_name)}</td>
          <td>${room.floor_level ?? '—'}</td></tr>`).join(''))}
        <details><summary>Rate history and scheduled changes</summary>
          ${table([['Effective from'], ['Nightly rate', 'numeric']], rates.map((rate) => `<tr><td>${e(rate.rate_start_date)}
            ${rate.rate_start_date > today ? '<span class="badge badge-pending">Scheduled</span>' : ''}</td>
            <td class="numeric">${money(rate.nightly_rate_mad)}</td></tr>`).join(''))}
        </details>
      </section>`;
    }).join('')}</div>`;
}

function bindInventory(catalog) {
  const chooseType = `<label class="span-all">Room type<select name="room_type_id" required>${typeOptions(catalog)}</select></label>`;
  const roomFields = field('Room number', 'room_no', 'required maxlength="12"') +
    field('Room name (optional)', 'room_name', 'maxlength="80"') +
    field('Floor (optional)', 'floor_level', 'type="number" min="-32768" max="32767" step="1"');
  const rateFields = field('Effective date', 'rate_start_date', `type="date" value="${today}" required`) +
    field('Nightly rate (MAD)', 'nightly_rate_mad', amountAttributes);
  const onSave = (endpoint, message) => async (values) => {
    await api(endpoint, { ...values, has_balcony: values.has_balcony === 'on' });
    notify(message);
    await render();
  };
  const forms = {
    room: ['Add physical room', chooseType + roomFields, 'Save room', onSave('/rooms', 'Room added.')],
    rate: ['Add a catalogue rate', chooseType + rateFields, 'Save rate', onSave('/rates', 'Rate added.')],
    type: ['Add room type', field('Type name', 'type_name', 'required maxlength="80"') +
      field('Bed configuration', 'bed_config', 'required maxlength="100"') +
      field('Maximum occupancy', 'max_occupancy', 'type="number" min="1" max="32767" required') +
      '<label class="check-label"><input type="checkbox" name="has_balcony"> Has balcony</label>' +
      '<label class="span-all">Description (optional)<textarea name="description"></textarea></label>' +
      '<h3 class="span-all">First physical room</h3>' + roomFields +
      '<h3 class="span-all">Initial rate</h3>' + rateFields, 'Save room type', onSave('/room-types', 'Room type added.')],
  };
  workspace.querySelectorAll('[data-inventory]').forEach((button) =>
    button.addEventListener('click', () => editDialog(...forms[button.dataset.inventory])));
}

function bindFilter(id, page) {
  const form = document.querySelector(id);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const params = new URLSearchParams(Array.from(new FormData(form)).filter(([, value]) => value));
    location.hash = params.size ? `#${page}?${params}` : `#${page}`;
  });
}

async function render() {
  const version = ++currentPage;
  const [requested, query] = location.hash.slice(1).split('?');
  const detail = requested.match(/^reservation\/(\d+)$/);
  const next = detail || requested === 'new' ? 'reservations' :
    Object.hasOwn(sections, requested) ? requested : 'overview';
  const params = new URLSearchParams(query);
  document.querySelector('#section-label').textContent = sections[next];
  document.querySelectorAll('[data-nav]').forEach((link) => {
    if (link.dataset.nav === next) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  workspace.setAttribute('aria-busy', 'true');
  workspace.innerHTML = '<p class="loading">Loading reception desk…</p>';

  function display(html) {
    if (version !== currentPage) return false;
    workspace.innerHTML = html;
    workspace.setAttribute('aria-busy', 'false');
    return true;
  }

  try {
    if (detail) {
      const [overview, booking] = await Promise.all([api('/overview'), api(`/reservations/${detail[1]}`)]);
      if (version !== currentPage) return;
      setToday(overview.today);
      if (display(detailPage(booking))) bindDetail(booking);
    } else if (requested === 'new') {
      const [catalog, guests] = await Promise.all([api('/catalog'), api('/guests')]);
      if (version !== currentPage) return;
      setToday(catalog.today);
      if (display(newBookingPage(catalog, guests, params))) bindNewBooking(catalog);
    } else if (next === 'overview') {
      const [stats, bookings, arrivals] = await Promise.all([api('/overview'), api('/reservations'), api('/arrivals')]);
      if (version !== currentPage) return;
      setToday(stats.today);
      display(overviewPage(stats, bookings, arrivals));
    } else if (next === 'reservations') {
      const [overview, bookings] = await Promise.all([api('/overview'), api(`/reservations?${params}`)]);
      if (version !== currentPage) return;
      setToday(overview.today);
      if (display(reservationsPage(bookings, params))) bindFilter('#booking-search', 'reservations');
    } else if (next === 'arrivals') {
      const [overview, arrivals] = await Promise.all([api('/overview'), api(`/arrivals?${params}`)]);
      if (version !== currentPage) return;
      setToday(overview.today);
      if (display(arrivalsPage(arrivals, params.get('date') || today))) bindFilter('#arrival-search', 'arrivals');
    } else {
      const catalog = await api('/catalog');
      if (version !== currentPage) return;
      setToday(catalog.today);
      if (next === 'inventory') {
        if (display(inventoryPage(catalog))) bindInventory(catalog);
      } else if (display(availabilityPage(catalog))) {
        const form = workspace.querySelector('#availability-form');
        const results = workspace.querySelector('#availability-results');
        attachDates(form, 'check_in', 'check_out');
        submit(form, async (values) => {
          const rooms = await api(`/availability?${new URLSearchParams(values)}`);
          results.innerHTML = availabilityResults(rooms, values);
        });
        form.requestSubmit();
      }
    }
  } catch (error) {
    display(heading('Unable to load this page', error.message, secondary('#overview', 'Back to overview')));
  }
}

document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  workspace.focus();
});
window.addEventListener('hashchange', render);
void render();
