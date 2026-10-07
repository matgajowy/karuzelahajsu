async function apiRequest(path, options = {}) {
  const response = await fetch(path, options);
  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(`Odpowiedź serwera nie jest poprawnym JSON-em (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(data.message || `Żądanie nie powiodło się (HTTP ${response.status}).`);
  }

  return data;
}
