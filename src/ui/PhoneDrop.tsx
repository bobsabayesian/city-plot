import { useRef, useState } from 'react';
import { BATCH, makeThumb, sendDrop, type DropItem } from '../drop';
import { readPhotoInfo } from '../photos';
import { photoStopName } from '../features/photoStops';

interface Sent { key: string; name: string; thumb?: string; located: boolean }

/**
 * The phone's side of a photo drop: pick photos, and their locations, dates and small thumbnails go to the computer
 * that showed the QR code. The photos themselves stay on the phone.
 */
export function PhoneDrop({ token }: { token: string }) {
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [sent, setSent] = useState<Sent[]>([]);

  const send = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr('');
    const list = [...files];
    try {
      for (let i = 0; i < list.length; i += BATCH) {
        const part = list.slice(i, i + BATCH);
        setBusy(`Reading ${Math.min(i + BATCH, list.length)} of ${list.length}…`);
        const items: DropItem[] = await Promise.all(part.map(async (f) => {
          const info = readPhotoInfo(await f.arrayBuffer());
          const thumb = await makeThumb(f);
          return { file: f.name, info, ...(thumb ? { thumb } : {}) };
        }));
        setBusy(`Sending ${Math.min(i + BATCH, list.length)} of ${list.length}…`);
        await sendDrop(token, items);
        setSent((s) => [...s, ...items.map((it, k) => ({ key: `${Date.now()}-${i + k}`, name: photoStopName(it), thumb: it.thumb, located: it.info.lat !== undefined }))]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not send the photos');
    } finally {
      setBusy('');
      if (picker.current) picker.current.value = '';
    }
  };

  const located = sent.filter((s) => s.located).length;
  return (
    <main className="phone-drop">
      <h1>Send photos to City Plot</h1>
      <p className="lede">Pick the photos for your memory route. Each one's location and date go to your computer, with a small preview; the photos themselves stay on this phone.</p>
      <button type="button" className="primary big" disabled={!!busy} onClick={() => picker.current?.click()}>{busy || (sent.length ? 'Send more photos' : 'Choose photos')}</button>
      <input ref={picker} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => void send(e.target.files)} />
      {err && <div className="err" role="alert">{err}</div>}
      {sent.length > 0 && (<>
        <p role="status">Sent {sent.length} {sent.length === 1 ? 'photo' : 'photos'} to your computer{located < sent.length ? `; ${sent.length - located} without a location, to place on the computer` : ''}.</p>
        {located < sent.length && <p className="hint">Phones often remove the location when photos are picked from the library in a browser. Choosing the original files (from Files) usually keeps it.</p>}
        <ul className="sent">
          {sent.map((s) => (
            <li key={s.key}>
              {s.thumb ? <img src={s.thumb} alt="" /> : <span className="noimg" aria-hidden="true" />}
              <span>{s.name}</span>
              <span className="hint">{s.located ? '✓ location' : 'no location'}</span>
            </li>
          ))}
        </ul>
      </>)}
      <p className="hint">This link works for an hour. You can close this page when you're done.</p>
    </main>
  );
}
