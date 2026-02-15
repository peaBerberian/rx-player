import config from "../config";
import EnvDetector from "./env_detector";

/**
 * On safari mobile (version 17.1.2) seeking too early cause the video to never buffer
 * media data. Using delaying mechanisms such as `setTimeout(fn, 0)` defers the seek
 * to a moment at which safari should be more able to handle a seek.
 * @returns {boolean}
 */
export default function shouldWaitCanPlayEventForSeeking(): boolean {
  const { FORCE_WAIT_CAN_PLAY_FOR_SEEKING } = config.getCurrent();
  return (
    FORCE_WAIT_CAN_PLAY_FOR_SEEKING ||
    EnvDetector.browser === EnvDetector.BROWSERS.SafariMobile ||
    EnvDetector.browser === EnvDetector.BROWSERS.SafariDesktop
  );
}
