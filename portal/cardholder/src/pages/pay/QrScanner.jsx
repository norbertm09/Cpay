import React, { useEffect, useRef, useState } from 'react';
import { Alert } from '../../components';

/**
 * Lecture de QR code par la camera (API BarcodeDetector quand disponible).
 * `onResult(text)` est appele une seule fois ; `onUnsupported()` si le
 * navigateur ne sait pas decoder les QR codes.
 */
export default function QrScanner({ onResult, onUnsupported, active }) {
  const videoRef = useRef(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active) return undefined;
    const supported = typeof window !== 'undefined' && 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia;
    if (!supported) { onUnsupported?.(); return undefined; }
    let stream = null; let timer = null; let stopped = false;
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    const stop = () => { stopped = true; if (timer) clearInterval(timer); if (stream) stream.getTracks().forEach((t) => t.stop()); };
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = s;
        v.play().catch(() => {});
        timer = setInterval(async () => {
          if (!v.videoWidth) return;
          try {
            const codes = await detector.detect(v);
            if (codes.length && codes[0].rawValue) { stop(); onResult(codes[0].rawValue); }
          } catch (e) { /* image non decodable a cet instant */ }
        }, 350);
      })
      .catch((e) => {
        setError(e?.name === 'NotAllowedError' ? 'L’accès à la caméra a été refusé. Autorisez la caméra ou saisissez le code manuellement.' : 'Caméra indisponible sur cet appareil. Saisissez le code manuellement.');
      });
    return stop;
  }, [active, onResult, onUnsupported]);

  if (error) return <Alert tone="warn">{error}</Alert>;
  return (
    <div className="qr-view" aria-label="Aperçu de la caméra">
      <video ref={videoRef} muted playsInline />
      <div className="qr-frame" aria-hidden="true" />
      <div className="qr-hint">Placez le QR code du commerçant dans le cadre</div>
    </div>
  );
}
