export async function request(url, body, signal) {
  const response = await fetch(
    url,
    body === undefined
      ? { signal }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "本机评审服务未返回有效结果。");
  return result;
}
export async function base64(bytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(new Blob([bytes]));
  });
}
