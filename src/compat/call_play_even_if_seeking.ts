import { isSafariDesktop } from "./browser_detection";

/**
 * 2025-06-18: We saw that Safari sometimes just decide to keep being at
 * `HTMLMediaElement.prototype.seeking === true` until we call
 * `HTMLMediaElement.prototype.play()` at least for Directfile contents on
 * Safari desktop (I didn't test the rest) though the RxPlayer often does the
 * reverse: we wait for `seeking` to be set to `false` before calling `play()`
 * to ensure smooth playback.
 *
 * This function allows to disable this lock for those devices.
 * @param {boolean} isDirectfile
 * @returns {boolean}
 */
export default function callPlayEvenIfSeeking(isDirectfile: boolean): boolean {
  return isDirectfile && isSafariDesktop;
}
