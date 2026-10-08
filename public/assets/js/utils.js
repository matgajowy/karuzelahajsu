function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatCK(value, asHtml = true) {
  const parsed = Number(value);
  const amount = (Number.isFinite(parsed) ? parsed : 0).toLocaleString("pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  if (!asHtml) return `${amount} CK`;

  return `
    <span class="ck-token font-mono tabular-nums">
      <span>${amount}</span>
      <span class="ck-badge" title="Cyrk Koin (1 CK = 1 PLN)">
        <span class="ck-icon">🎪</span><span class="ck-ticker">CK</span>
      </span>
    </span>
  `.trim();
}

function formatQuotePrice(value, currency) {
  const parsed = Number(value);
  const amount = (Number.isFinite(parsed) ? parsed : 0).toLocaleString("pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${amount} ${currency === "PLN" ? "CK" : currency}`;
}
