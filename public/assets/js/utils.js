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

function renderGoldCoinSvg(large = false) {
  const id = ++ckCoinSequence;
  const faceGradient = `coinGold${id}`;
  const rimGradient = `coinRim${id}`;
  const shadowFilter = `embossShadow${id}`;

  return `
    <svg class="ck-coin${large ? " ck-coin-lg" : ""}" viewBox="0 0 32 32" width="${large ? 32 : 28}" height="${large ? 32 : 28}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Cyrk Koin">
      <defs>
        <radialGradient id="${faceGradient}" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stop-color="#FFFBEB"/>
          <stop offset="25%" stop-color="#FDE047"/>
          <stop offset="60%" stop-color="#D97706"/>
          <stop offset="90%" stop-color="#B45309"/>
          <stop offset="100%" stop-color="#78350F"/>
        </radialGradient>
        <linearGradient id="${rimGradient}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#FEF08A"/>
          <stop offset="40%" stop-color="#F59E0B"/>
          <stop offset="80%" stop-color="#92400E"/>
          <stop offset="100%" stop-color="#451A03"/>
        </linearGradient>
        <filter id="${shadowFilter}" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="0.75" stdDeviation="0.4" flood-color="#451A03" flood-opacity="0.8"/>
        </filter>
      </defs>
      <circle cx="16" cy="16" r="15" fill="url(#${rimGradient})" stroke="#FEF9C3" stroke-width="0.6"/>
      <circle cx="16" cy="16" r="13.4" fill="none" stroke="#78350F" stroke-width="0.5" stroke-dasharray="1 1"/>
      <circle cx="16" cy="16" r="12.3" fill="url(#${faceGradient})" stroke="#FDE68A" stroke-width="0.4"/>
      <g filter="url(#${shadowFilter})">
        <line x1="16" y1="5.2" x2="16" y2="7.5" stroke="#FEF9C3" stroke-width="0.7" stroke-linecap="round"/>
        <path d="M16 5.5L18.2 6.4L16 7.3Z" fill="#DC2626"/>
        <path d="M16 7.5L22 13.2H10L16 7.5Z" fill="#FFFBEB"/>
        <path d="M16 7.5L18.2 13.2H13.8L16 7.5Z" fill="#B91C1C"/>
        <path d="M20.2 11.5L22 13.2H19.5L18.8 11.5Z" fill="#B91C1C"/>
        <path d="M11.8 11.5L10 13.2H12.5L13.2 11.5Z" fill="#B91C1C"/>
        <rect x="9.5" y="13.2" width="13" height="1" rx="0.5" fill="#78350F"/>
      </g>
      <g filter="url(#${shadowFilter})">
        <text x="16" y="23.8" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-weight="900" font-size="9.8" fill="#991B1B" stroke="#FEF08A" stroke-width="0.35" text-anchor="middle" letter-spacing="0.4">CK</text>
      </g>
    </svg>
  `.trim();
}

function formatCK(value, asHtml = true, largeBadge = false) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? parsed : 0;
  const rounded = Math.abs(normalized) < 0.005 ? 0 : normalized;
  const amount = rounded.toLocaleString("pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  if (!asHtml) return `${amount} CK`;

  return `
    <span class="ck-token font-mono tabular-nums" title="Cyrk Koin (1 CK = 1 PLN)">
      <span>${amount}</span>
      ${renderGoldCoinSvg(largeBadge)}
    </span>
  `.trim();
}

function formatPct(value) {
  const parsed = Number(value);
  const percentage = (Number.isFinite(parsed) ? parsed : 0) * 100;
  if (Math.abs(percentage) < 0.005) return "0.00%";
  return `${percentage > 0 ? "+" : ""}${percentage.toFixed(2)}%`;
}

function pctColorClass(value) {
  const parsed = Number(value);
  const percentage = (Number.isFinite(parsed) ? parsed : 0) * 100;
  if (Math.abs(percentage) < 0.005) return "text-slate-400";
  return percentage > 0 ? "text-emerald-400" : "text-rose-400";
}

function formatTime(dateString) {
  if (!dateString) return "--:--";
  const timestamp = String(dateString);
  const normalizedTimestamp = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)
    ? timestamp
    : `${timestamp.replace(" ", "T")}Z`;
  const date = new Date(normalizedTimestamp);
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
