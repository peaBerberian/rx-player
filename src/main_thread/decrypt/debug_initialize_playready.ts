import type {
  IMediaElement,
  IMediaKeys,
} from "../../compat/browser_compatibility_types.ts";
import log from "../../log.ts";
import type { CancellationSignal } from "../../utils/task_canceller.ts";

/** Temporary debugging probe for the Edge / PlayReady clear-content stall. */
export default function debugInitializePlayReady(
  mediaElement: IMediaElement,
  mediaKeys: IMediaKeys,
  cancelSignal: CancellationSignal,
): void {
  // Change to 0 to initialize as soon as content metadata is available.
  const delayMs = 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onMetadata = () => {
    mediaElement.removeEventListener("loadedmetadata", onMetadata);
    timer = setTimeout(runProbe, delayMs);
  };
  mediaElement.addEventListener("loadedmetadata", onMetadata);
  cancelSignal.register(() => {
    mediaElement.removeEventListener("loadedmetadata", onMetadata);
    clearTimeout(timer);
  });
  // Metadata may already be available when attachment finishes.
  if (mediaElement.readyState >= 1) {
    onMetadata();
  }

  function runProbe(): void {
    if (cancelSignal.isCancelled()) {
      return;
    }
    try {
      // ONDEMAND header: no KID and no license-server URL.
      const xml =
        '<WRMHEADER xmlns="http://schemas.microsoft.com/DRM/2007/03/PlayReadyHeader" version="4.1.0.0"><DATA><DECRYPTORSETUP>ONDEMAND</DECRYPTORSETUP></DATA></WRMHEADER>';
      const pssh = new Uint8Array(42 + xml.length * 2);
      const d = new DataView(pssh.buffer);
      d.setUint32(0, pssh.length);
      pssh.set([0x70, 0x73, 0x73, 0x68], 4);
      pssh.set(
        [
          0x9a, 0x04, 0xf0, 0x79, 0x98, 0x40, 0x42, 0x86, 0xab, 0x92, 0xe6, 0x5b, 0xe0,
          0x88, 0x5f, 0x95,
        ],
        12,
      );
      d.setUint32(28, pssh.length - 32);
      d.setUint32(32, pssh.length - 32, true);
      d.setUint16(36, 1, true);
      d.setUint16(38, 1, true);
      d.setUint16(40, xml.length * 2, true);
      for (let i = 0; i < xml.length; i++) {
        d.setUint16(42 + i * 2, xml.charCodeAt(i), true);
      }

      // Bypass the normal session store/listeners: never call getLicense.
      // Retain this session until content disposal, matching Microsoft's probe.
      const session = mediaKeys.createSession("temporary");
      const onMessage = (event: MediaKeyMessageEvent) => {
        log.warn("DRM", "PlayReady debug probe message (no license submitted)", {
          messageType: event.messageType,
          sessionId: session.sessionId,
        });
      };
      session.addEventListener("message", onMessage);
      cancelSignal.register(() => {
        session.removeEventListener("message", onMessage);
        try {
          session.close().catch((err: unknown) => {
            log.warn("DRM", "PlayReady debug probe close failed", String(err));
          });
        } catch (err) {
          log.warn("DRM", "PlayReady debug probe close failed", String(err));
        }
      });
      log.warn("DRM", "PlayReady debug probe: generating request", { delayMs });
      session.generateRequest("cenc", pssh).then(
        () => {
          log.warn("DRM", "PlayReady debug probe initialized", {
            sessionId: session.sessionId,
          });
        },
        (err: unknown) => {
          log.warn("DRM", "PlayReady debug probe generateRequest failed", String(err));
        },
      );
    } catch (err) {
      log.warn("DRM", "PlayReady debug probe failed", String(err));
    }
  }
}
