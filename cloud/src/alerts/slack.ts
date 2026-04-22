export async function postToSlack(
  webhookUrl: string | undefined,
  text: string,
): Promise<void> {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    // swallow — alert is already persisted in D1; Slack is best-effort
  }
}
