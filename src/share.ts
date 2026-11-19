/** Put an SVG on the server and get a link to it that works for an hour. */
export async function createShareLink(svg: string): Promise<{ url: string; expiresAt: number }> {
  const res = await fetch('/api/share', { method: 'POST', headers: { 'content-type': 'image/svg+xml' }, body: svg });
  if (res.status === 413) throw new Error('The SVG is too large to share by link.');
  if (!res.ok) throw new Error(`Could not make the link (${res.status}).`);
  const { path, expiresAt } = (await res.json()) as { path: string; expiresAt: number };
  return { url: `${location.origin}${path}`, expiresAt };
}
