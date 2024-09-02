import { config } from "../../../experimental";
import log from "../../../log";
import type { IAdaptation, IPeriod, IRepresentation } from "../../../manifest";
import type {
  IFreezingStatus,
  IRebufferingStatus,
  ObservationPosition,
} from "../../../playback_observer";
import isNullOrUndefined from "../../../utils/is_null_or_undefined";
import getMonotonicTimeStamp from "../../../utils/monotonic_timestamp";
import type SegmentSinksStore from "../../segment_sinks";
import type { IBufferedChunk } from "../../segment_sinks";

/** Describe a strategy that can be taken to un-freeze playback. */
export type IFreezeResolution =
  | {
      /**
       * Set when there is a freeze which seem to be specifically linked to a,
       * or multiple, content's `Representation`.
       *
       * In that case, the recommendation is to avoid playing those
       * `Representation` at all.
       */
      type: "deprecate-representations";
      /** The `Representation` to avoid. */
      value: Array<{
        adaptation: IAdaptation;
        period: IPeriod;
        representation: IRepresentation;
      }>;
    }
  | {
      /**
       * Set when there is a freeze which seem to be fixable by just
       * "flushing" the buffer, e.g. generally by just seeking to another,
       * close, position.
       */
      type: "flush";
      value: {
        /**
         * The relative position, when compared to the current playback
         * position, we should be playing at after the flush.
         */
        relativeSeek: number;
      };
    }
  | {
      /**
       * Set when there is a freeze which seem to be fixable by "reloading"
       * the content: meaning re-creating a `MediaSource` and its associated
       * buffers.
       */
      type: "reload";
      value: null;
    };

/**
 * Sometimes playback is stuck for no known reason, despite having data in
 * buffers.
 *
 * This can be due to relatively valid cause: performance being slow on the
 * device making the content slow to start up, decryption keys not being
 * obtained / usable yet etc.
 *
 * Yet in many cases, this is abnormal and may lead to being stuck at the same
 * position and video frame indefinitely.
 *
 * For those situations, we have a series of tricks and heuristic, which are
 * implemented by the `FreezeResolver`.
 *
 * @class FreezeResolver
 */
export default class FreezeResolver {
  /** Emit the current playback conditions */
  private _segmentSinksStore: SegmentSinksStore;

  /** Contains a short-term history of what content has been played recently. */
  private _lastSegmentInfo: {
    /** Playback history for the video data. */
    video: IPlayedHistoryEntry[];
    /** Playback history for the audio data. */
    audio: IPlayedHistoryEntry[];
  };

  /**
   * Information on the last attempt to un-freeze playback by "flushing" buffers.
   *
   * `null` if we never attempted to flush buffers.
   */
  private _lastFlushAttempt: {
    /** Monotonically-raising timestamp at the time when we attempted the flush. */
    timestamp: number;
    /** Playback position at which the flush was performed, in seconds. */
    position: number;
  } | null;

  /**
   * If set to something else than `null`, this is the monotonically-raising
   * timestamp used by the RxPlayer when playback begin to seem to not start
   * despite having decipherable data in the buffer(s).
   *
   * If enough time in that condition is spent, special considerations are
   * taken at which point `_decipherabilityFreezeStartingTimestamp` is reset to
   * `null`.
   *
   * It is also reset to `null` when and if there is no such issue anymore.
   */
  private _decipherabilityFreezeStartingTimestamp: number | null;

  constructor(segmentSinksStore: SegmentSinksStore) {
    this._segmentSinksStore = segmentSinksStore;
    this._decipherabilityFreezeStartingTimestamp = null;
    this._lastFlushAttempt = null;
    this._lastSegmentInfo = {
      audio: [],
      video: [],
    };
  }

  /**
   * Check that playback is not freezing, and if it is, return a solution that
   * should be atempted to unfreeze it.
   *
   * Returns `null` either when there's no freeze is happening or if there's one
   * but there's nothing we should do about it yet.
   *
   * Refer to the returned type's definition for more information.
   *
   * @param {Object} observation - The last playback observation produced, it
   * has to be recent (just triggered for example).
   * @returns {Object|null}
   */
  public onNewObservation(
    observation: IFreezeResolverObservation,
  ): IFreezeResolution | null {
    const now = getMonotonicTimeStamp();
    this._addPositionToHistory(observation, now);

    const { readyState, rebuffering, freezing, fullyLoaded } = observation;
    const polledPosition = observation.position.getPolled();
    const bufferGap =
      observation.bufferGap !== undefined && isFinite(observation.bufferGap)
        ? observation.bufferGap
        : 0;

    const {
      UNFREEZING_SEEK_DELAY,
      UNFREEZING_DELTA_POSITION,
      FREEZING_FLUSH_FAILURE_DELAY,
    } = config.getCurrent();

    const isFrozen =
      freezing !== null ||
      // When rebuffering, `freezing` might be not set as we're actively pausing
      // playback. Yet, rebuffering occurences can also be abnormal, such as
      // when enough buffer is constructed but with a low readyState (those are
      // generally decryption issues).
      (rebuffering !== null && readyState === 1 && (bufferGap >= 6 || fullyLoaded));

    if (!isFrozen) {
      this._decipherabilityFreezeStartingTimestamp = null;
      return null;
    }

    const recentFlushAttemptFailed =
      this._lastFlushAttempt !== null &&
      now - this._lastFlushAttempt.timestamp < FREEZING_FLUSH_FAILURE_DELAY.MAXIMUM &&
      now - this._lastFlushAttempt.timestamp >= FREEZING_FLUSH_FAILURE_DELAY.MINIMUM &&
      Math.abs(polledPosition - this._lastFlushAttempt.position) <
        FREEZING_FLUSH_FAILURE_DELAY.POSITION_DELTA;

    if (recentFlushAttemptFailed) {
      log.warn(
        "FR: A recent flush seemed to have no effect on freeze, checking for transitions",
      );
      const toDeprecate = [];
      for (const ttype of ["audio", "video"] as const) {
        const segmentList = this._lastSegmentInfo[ttype];
        if (segmentList.length === 0) {
          break;
        }
        let initialOccurenceOfLastSegment = segmentList[segmentList.length - 1];
        let recentQualityChangeSegment: IPlayedHistoryEntry | undefined;
        for (let i = segmentList.length - 2; i >= 0; i--) {
          const segment = segmentList[i];
          log.warn(
            "FR: !!!!!!",
            ttype,
            initialOccurenceOfLastSegment.segment?.infos.representation.bitrate,
            segment.segment?.infos.representation.bitrate,
            segment.timestamp - initialOccurenceOfLastSegment.timestamp,
          );
          if (segment.segment === null) {
            recentQualityChangeSegment = segment;
            break;
          } else if (
            segment.segment.infos.representation.uniqueId !==
              initialOccurenceOfLastSegment.segment?.infos.representation.uniqueId &&
            initialOccurenceOfLastSegment.timestamp - segment.timestamp < 5000
          ) {
            recentQualityChangeSegment = segment;
            break;
          } else if (
            initialOccurenceOfLastSegment.segment !== null &&
            segment.segment.start === initialOccurenceOfLastSegment.segment.start
          ) {
            initialOccurenceOfLastSegment = segment;
          }
        }
        if (
          recentQualityChangeSegment !== undefined &&
          recentQualityChangeSegment.segment !== null
        ) {
          if (initialOccurenceOfLastSegment.segment === null) {
            log.debug("FR: Freeze when beginning to play a content, reloading");
            return { type: "reload", value: null };
          } else if (
            initialOccurenceOfLastSegment.segment.infos.period.id !==
            recentQualityChangeSegment.segment.infos.period.id
          ) {
            log.debug("FR: Freeze when switching Period, reloading");
            return { type: "reload", value: null };
          } else if (
            initialOccurenceOfLastSegment.segment.infos.representation.uniqueId !==
            recentQualityChangeSegment.segment.infos.representation.uniqueId
          ) {
            log.warn(
              "FR: Freeze when switching Representation, deprecating",
              initialOccurenceOfLastSegment.segment.infos.representation.bitrate,
            );
            toDeprecate.push({
              adaptation: initialOccurenceOfLastSegment.segment.infos.adaptation,
              period: initialOccurenceOfLastSegment.segment.infos.period,
              representation: initialOccurenceOfLastSegment.segment.infos.representation,
            });
          }
        }
      }

      if (toDeprecate.length > 0) {
        this._decipherabilityFreezeStartingTimestamp = null;
        return { type: "deprecate-representations", value: toDeprecate };
      } else {
        // XXX TODO just reload here?
      }
    }
    if (
      freezing !== null &&
      !observation.position.isAwaitingFuturePosition() &&
      now - freezing.timestamp > UNFREEZING_SEEK_DELAY
    ) {
      this._lastFlushAttempt = {
        timestamp: now,
        position: polledPosition + UNFREEZING_DELTA_POSITION,
      };

      return {
        type: "flush",
        value: { relativeSeek: UNFREEZING_DELTA_POSITION },
      };
    }

    if ((bufferGap < 6 && !fullyLoaded) || readyState > 1) {
      this._decipherabilityFreezeStartingTimestamp = null;
      return null;
    }

    if (this._decipherabilityFreezeStartingTimestamp === null) {
      this._decipherabilityFreezeStartingTimestamp = now;
    }
    const rebufferingForTooLong =
      rebuffering !== null && now - rebuffering.timestamp > 4000;
    const frozenForTooLong = freezing !== null && now - freezing.timestamp > 4000;

    if (
      (rebufferingForTooLong || frozenForTooLong) &&
      getMonotonicTimeStamp() - this._decipherabilityFreezeStartingTimestamp > 4000
    ) {
      let hasOnlyDecipherableSegments = true;
      let isClear = true;
      for (const ttype of ["audio", "video"] as const) {
        const status = this._segmentSinksStore.getStatus(ttype);
        if (status.type === "initialized") {
          for (const segment of status.value.getLastKnownInventory()) {
            const { representation } = segment.infos;
            if (representation.decipherable === false) {
              log.warn(
                "FR: we have undecipherable segments left in the buffer, reloading",
              );
              this._decipherabilityFreezeStartingTimestamp = null;
              return { type: "reload", value: null };
            } else if (representation.contentProtections !== undefined) {
              isClear = false;
              if (representation.decipherable !== true) {
                hasOnlyDecipherableSegments = false;
              }
            }
          }
        }
      }

      if (!isClear && hasOnlyDecipherableSegments) {
        log.warn(
          "FR: we are frozen despite only having decipherable " +
            "segments left in the buffer, reloading",
        );
        this._decipherabilityFreezeStartingTimestamp = null;
        return { type: "reload", value: null };
      }
    }
    return null;
  }

  /**
   * Add entry to `this._lastSegmentInfo` for the position that is currently
   * played according to the given `observation`.
   *
   * @param {Object} observation
   * @param {number} currentTimestamp
   */
  private _addPositionToHistory(
    observation: IFreezeResolverObservation,
    currentTimestamp: number,
  ): void {
    const position = observation.position.getPolled();
    for (const ttype of ["audio", "video"] as const) {
      const status = this._segmentSinksStore.getStatus(ttype);
      if (status.type === "initialized") {
        for (const segment of status.value.getLastKnownInventory()) {
          if (segment.start <= position && segment.end > position) {
            this._lastSegmentInfo[ttype].push({
              segment,
              position,
              timestamp: currentTimestamp,
            });
          }
        }
      } else {
        this._lastSegmentInfo[ttype].push({
          segment: null,
          position,
          timestamp: currentTimestamp,
        });
      }
      if (this._lastSegmentInfo[ttype].length > 100) {
        const toRemove = this._lastSegmentInfo[ttype].length - 100;
        this._lastSegmentInfo[ttype].splice(0, toRemove);
      }

      const removalTs = currentTimestamp - 60000;
      let i;
      for (i = 0; i < this._lastSegmentInfo[ttype].length; i++) {
        if (this._lastSegmentInfo[ttype][i].timestamp > removalTs) {
          break;
        }
      }
      if (i > 0) {
        this._lastSegmentInfo[ttype].splice(0, i);
      }
    }
  }
}

/** Entry for the playback history maintained by the `FreezeResolver`. */
interface IPlayedHistoryEntry {
  /**
   * Segment and related information that seemed to be played at the
   * associated timestamp and playback position.
   *
   * Note that this is only a guess and not a certainty.
   */
  segment: null | IBufferedChunk;
  /**
   * Playback position, in seconds, as seen on the `HTMLMediaElement`, at which
   * we were playing.
   */
  position: number;
  /** Monotonically-raising timestamp for that entry. */
  timestamp: number;
}

/** Playback observation needed by the `FreezeResolver`. */
export interface IFreezeResolverObservation {
  /** Current `readyState` value on the media element. */
  readyState: number;
  /**
   * Set if the player is short on audio and/or video media data and is a such,
   * rebuffering.
   * `null` if not.
   */
  rebuffering: IRebufferingStatus | null;
  /**
   * Set if the player is frozen, that is, stuck in place for unknown reason.
   * Note that this reason can be a valid one, such as a necessary license not
   * being obtained yet.
   *
   * `null` if the player is not frozen.
   */
  freezing: IFreezingStatus | null;
  /**
   * Gap between `currentTime` and the next position with un-buffered data.
   * `Infinity` if we don't have buffered data right now.
   * `undefined` if we cannot determine the buffer gap.
   */
  bufferGap: number | undefined;
  position: ObservationPosition;
  /** If `true` the content is loaded until its maximum position. */
  fullyLoaded: boolean;
}
