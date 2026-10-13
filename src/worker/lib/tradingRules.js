// Reguły dopuszczające walory do handlu.
// Minimalny kurs zakupu: 0,01 w walucie kwotowania (USD dla akcji USA, CK = PLN dla GPW).
// Akcje groszkowe (np. 0,0001 USD) pozwalają kupić setki tysięcy sztuk za grosze i zniekształcają ligę.
export const MIN_BUY_PRICE = 0.01;

export function isBelowMinPrice(price) {
  const value = Number(price);
  return Number.isFinite(value) && value < MIN_BUY_PRICE;
}

const formatNumber = value => Number(value).toLocaleString("pl-PL", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

export function priceTooLowMessage(ticker, price, currency = "USD") {
  const unit = currency === "PLN" ? "CK" : currency;
  return `Walor ${ticker} jest niedostępny: jego kurs (${formatNumber(price)} ${unit}) jest poniżej minimum ${formatNumber(MIN_BUY_PRICE)} ${unit}. ` +
    `Akcje groszkowe są wyłączone z handlu w lidze — wybierz walor o kursie co najmniej ${formatNumber(MIN_BUY_PRICE)} ${unit}.`;
}
