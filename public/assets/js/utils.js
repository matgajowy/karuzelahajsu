function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

let ckCoinSequence = 0;

function renderGoldCoinSvg() {
  const id = ++ckCoinSequence;
  const faceGradient = `ckGoldFace${id}`;
  const rimGradient = `ckGoldRim${id}`;

  return `
    <svg class="ck-gold-coin" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <radialGradient id="${faceGradient}" cx="32%" cy="28%" r="68%">
          <stop offset="0%" stop-color="#FFFDE7"/>
          <stop offset="22%" stop-color="#FEEA61"/>
          <stop offset="55%" stop-color="#F59E0B"/>
          <stop offset="85%" stop-color="#B45309"/>
          <stop offset="100%" stop-color="#78350F"/>
        </radialGradient>
        <linearGradient id="${rimGradient}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#FEF9C3"/>
          <stop offset="35%" stop-color="#F59E0B"/>
          <stop offset="70%" stop-color="#D97706"/>
          <stop offset="100%" stop-color="#451A03"/>
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="15" fill="url(#${rimGradient})" stroke="#FEF08A" stroke-width="0.75"/>
      <circle cx="16" cy="16" r="13.3" fill="none" stroke="#78350F" stroke-width="0.65" stroke-dasharray="1.2 1.2"/>
      <circle cx="16" cy="16" r="12" fill="url(#${faceGradient})" stroke="#FDE047" stroke-width="0.5"/>
      <g transform="translate(0, -0.5)">
        <line x1="16" y1="5.2" x2="16" y2="7.2" stroke="#FFFBEB" stroke-width="0.7" stroke-linecap="round"/>
        <path d="M16 5.5L18 6.3L16 7.1Z" fill="#DC2626"/>
        <path d="M16 7L21.5 12.8H10.5L16 7Z" fill="#FFFBEB" opacity="0.95"/>
        <path d="M16 7L18.4 12.8H13.6L16 7Z" fill="#DC2626"/>
        <line x1="10" y1="13.2" x2="22" y2="13.2" stroke="#78350F" stroke-width="0.5" stroke-linecap="round"/>
      </g>
      <text x="16" y="23.2" font-family="'JetBrains Mono', monospace, sans-serif" font-weight="900" font-size="9" fill="#FFFDE7" text-anchor="middle" letter-spacing="-0.3" filter="drop-shadow(0px 1px 0px rgba(69, 26, 3, 0.95))">CK</text>
    </svg>
  `.trim();
}

function formatCK(value, asHtml = true, largeBadge = false) {
  const parsed = Number(value);
  const amount = (Number.isFinite(parsed) ? parsed : 0).toLocaleString("pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  if (!asHtml) return `${amount} CK`;
  const badgeClass = largeBadge ? "ck-badge ck-badge-lg" : "ck-badge";

  return `
    <span class="ck-token font-mono tabular-nums">
      <span>${amount}</span>
      <span class="${badgeClass}" title="Cyrk Koin (1 CK = 1 PLN)">
        ${renderGoldCoinSvg()}
        <span class="ck-ticker">CK</span>
      </span>
    </span>
  `.trim();
}

function formatPct(value) {
  const parsed = Number(value);
  const percentage = (Number.isFinite(parsed) ? parsed : 0) * 100;
  return `${percentage > 0 ? "+" : ""}${percentage.toFixed(2)}%`;
}

function formatTime(dateString) {
  if (!dateString) return "--:--";
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isBenchmark(name) {
  const normalized = String(name ?? "").toLowerCase();
  return normalized.includes("benchmark")
    || normalized.includes("index")
    || normalized.includes("s&p")
    || normalized.includes("wig");
}

function formatQuotePrice(value, currency) {
  const parsed = Number(value);
  const amount = (Number.isFinite(parsed) ? parsed : 0).toLocaleString("pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${amount} ${currency === "PLN" ? "CK" : currency}`;
}
