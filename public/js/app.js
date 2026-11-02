(function () {
  // Mobile sidebar
  const body = document.body;
  document.querySelectorAll('[data-nav-toggle]').forEach((b) => b.addEventListener('click', () => body.classList.toggle('nav-open')));
  document.querySelectorAll('[data-nav-close]').forEach((b) => b.addEventListener('click', () => body.classList.remove('nav-open')));

  // Dismissable alerts (auto-hide success messages)
  document.querySelectorAll('[data-dismiss]').forEach((el) => {
    const close = () => { el.classList.add('hide'); setTimeout(() => el.remove(), 250); };
    el.querySelector('.alert-x')?.addEventListener('click', close);
    if (el.classList.contains('alert-success')) setTimeout(close, 5000);
  });

  // Confirm dangerous actions
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-confirm]');
    if (b && !window.confirm(b.getAttribute('data-confirm'))) e.preventDefault();
  });

  // Plan picker: show the custom field only when "Custom" is chosen
  document.querySelectorAll('[data-plan-picker]').forEach((picker) => {
    const custom = picker.parentElement.querySelector('[data-plan-custom]');
    const input = custom && custom.querySelector('input');
    const sync = () => {
      const isCustom = picker.querySelector('input:checked')?.value === 'custom';
      if (custom) custom.hidden = !isCustom;
      if (input) input.required = isCustom;
    };
    picker.addEventListener('change', sync);
    sync();
  });

  // Password generator
  document.querySelectorAll('[data-generate]').forEach((btn) => btn.addEventListener('click', () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const arr = new Uint32Array(12);
    crypto.getRandomValues(arr);
    const pw = Array.from(arr, (n) => chars[n % chars.length]).join('');
    const input = btn.parentElement.querySelector('[data-password]');
    input.value = pw;
    input.select();
  }));

  // Show chosen logo filename
  document.querySelectorAll('[data-logo-input]').forEach((input) => input.addEventListener('change', () => {
    const span = input.parentElement.querySelector('span');
    if (span && input.files[0]) span.textContent = input.files[0].name;
  }));

  // Prevent double-submits
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f.dataset.submitted) { e.preventDefault(); return; }
    f.dataset.submitted = '1';
    setTimeout(() => delete f.dataset.submitted, 3000);
  });
})();
