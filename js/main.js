// ===== Mobile Nav Toggle =====
document.addEventListener('DOMContentLoaded', function () {
  var hamburger = document.querySelector('.nav-hamburger');
  var navLinks = document.querySelector('.nav-links');

  if (hamburger && navLinks) {
    hamburger.addEventListener('click', function () {
      navLinks.classList.toggle('open');
    });
  }

  // ===== Style Picker =====
  var styleCards = document.querySelectorAll('.style-card');
  var expanded = document.getElementById('style-expanded');

  if (styleCards.length > 0 && expanded) {
    var styleData = {
      Modern: {
        desc: 'Clean lines, dark backgrounds, and bold typography. Perfect for tech companies, startups, and creative professionals who want a sleek, contemporary look.',
        bg: '#1a1a2e',
        navColor: '#e0e0e0',
        navBg: 'rgba(255,255,255,0.05)',
        textColor: '#e0e0e0',
        btnBg: '#4a9ff5',
        cardBg: 'rgba(255,255,255,0.08)'
      },
      Classic: {
        desc: 'Warm tones, elegant typography, and a traditional layout with sidebar navigation. Great for established businesses, law firms, and professional services.',
        bg: '#faf5ee',
        navColor: '#5c4a32',
        navBg: 'rgba(92,74,50,0.08)',
        textColor: '#5c4a32',
        btnBg: '#8b6914',
        cardBg: 'rgba(92,74,50,0.08)'
      },
      Bold: {
        desc: 'Vibrant colors, large imagery, and high-energy layouts. Ideal for restaurants, entertainment venues, and brands that want to make a strong first impression.',
        bg: '#ff6b35',
        navColor: '#fff',
        navBg: 'rgba(255,255,255,0.15)',
        textColor: '#fff',
        btnBg: '#1a1a2e',
        cardBg: 'rgba(255,255,255,0.2)'
      },
      Minimal: {
        desc: 'Maximum whitespace, restrained color, and typography-focused design. Perfect for portfolios, writers, and businesses that value simplicity and clarity.',
        bg: '#ffffff',
        navColor: '#333',
        navBg: 'transparent',
        textColor: '#333',
        btnBg: '#333',
        cardBg: '#f5f5f5'
      }
    };

    styleCards.forEach(function (card) {
      card.addEventListener('click', function () {
        var styleName = card.getAttribute('data-style');
        var data = styleData[styleName];

        // Update aria-pressed
        styleCards.forEach(function (c) {
          c.setAttribute('aria-pressed', 'false');
        });
        card.setAttribute('aria-pressed', 'true');

        // Populate expanded preview
        expanded.querySelector('.style-expanded-name').textContent = styleName;
        expanded.querySelector('.style-expanded-desc').textContent = data.desc;

        var preview = expanded.querySelector('.style-expanded-preview');
        preview.style.background = data.bg;
        preview.innerHTML =
          '<div style="display:flex;justify-content:space-between;font-size:10px;color:' + data.navColor + ';background:' + data.navBg + ';padding:4px 8px;border-radius:4px;margin-bottom:12px;">Logo <span>Home &middot; About &middot; Contact</span></div>' +
          '<div style="text-align:center;padding:16px 0;">' +
          '<div style="height:6px;width:50%;margin:0 auto 8px;background:' + data.textColor + ';border-radius:3px;opacity:0.8;"></div>' +
          '<div style="height:4px;width:30%;margin:0 auto 12px;background:' + data.textColor + ';border-radius:3px;opacity:0.4;"></div>' +
          '<div style="height:10px;width:20%;margin:0 auto;background:' + data.btnBg + ';border-radius:5px;"></div>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">' +
          '<div style="height:30px;background:' + data.cardBg + ';border-radius:4px;"></div>' +
          '<div style="height:30px;background:' + data.cardBg + ';border-radius:4px;"></div>' +
          '<div style="height:30px;background:' + data.cardBg + ';border-radius:4px;"></div>' +
          '</div>';

        expanded.hidden = false;

        // Auto-fill style preference in form
        var stylePref = document.getElementById('style-pref');
        if (stylePref) {
          stylePref.value = styleName;
        }
      });
    });
  }

  // ===== EmailJS Contact Form =====
  var form = document.getElementById('contact-form-el');
  var formSuccess = document.getElementById('form-success');
  var formError = document.getElementById('form-error');
  var formRetry = document.getElementById('form-retry');

  // TODO: Replace these with your actual EmailJS IDs
  var EMAILJS_PUBLIC_KEY = 'YOUR_PUBLIC_KEY';
  var EMAILJS_SERVICE_ID = 'YOUR_SERVICE_ID';
  var EMAILJS_TEMPLATE_ID = 'YOUR_TEMPLATE_ID';

  if (typeof emailjs !== 'undefined') {
    emailjs.init(EMAILJS_PUBLIC_KEY);
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var submitBtn = form.querySelector('.form-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending...';

      if (typeof emailjs === 'undefined') {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Request';
        form.hidden = true;
        formError.hidden = false;
        return;
      }

      emailjs.sendForm(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, form)
        .then(function () {
          form.hidden = true;
          formSuccess.hidden = false;
        })
        .catch(function () {
          form.hidden = true;
          formError.hidden = false;
        });
    });
  }

  if (formRetry) {
    formRetry.addEventListener('click', function () {
      formError.hidden = true;
      form.hidden = false;
      var submitBtn = form.querySelector('.form-submit');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send Request';
    });
  }
});
