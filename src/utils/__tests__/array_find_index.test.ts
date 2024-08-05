import { describe, beforeEach, afterEach, it, expect, vi } from "vitest";
import arrayFindIndex from "../array_find_index";

/* eslint-disable no-invalid-this */
/* eslint-disable no-restricted-properties */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-restricted-types */

/* eslint-disable @typescript-eslint/unbound-method */
const initialArrayFindIndex = (Array.prototype as { findIndex: unknown }).findIndex;
/* eslint-enable @typescript-eslint/unbound-method */

describe("utils - arrayFindIndex", () => {
  beforeEach(() => {
    (Array.prototype as { findIndex: unknown }).findIndex = undefined;
  });

  afterEach(() => {
    (Array.prototype as { findIndex: unknown }).findIndex = initialArrayFindIndex;
  });

  it("should return -1 for an empty array", () => {
    expect(
      arrayFindIndex([], () => {
        return true;
      }),
    ).toBe(-1);
  });

  it("should return the first corresponding index if found", () => {
    const obj1 = {};
    const obj2 = {};
    expect(
      arrayFindIndex([obj2, obj1, obj2, obj1], (obj) => {
        return obj === obj1;
      }),
    ).toBe(1);
  });

  it("should return -1 if the element is not found", () => {
    const obj1 = {};
    const obj2 = {};
    const obj3 = {};
    expect(
      arrayFindIndex([obj2, obj1, obj2, obj1], (obj) => {
        return obj === obj3;
      }),
    ).toBe(-1);
  });

  it("should give an index as a second argument and the array as a third", () => {
    const obj1 = {};
    const obj2 = {};
    const arr = [obj2, obj1, obj2, obj1];
    let currentIndex = 0;
    expect(
      arrayFindIndex(arr, (obj, index, cArr) => {
        expect(index).toBe(currentIndex++);
        expect(cArr).toBe(arr);
        return obj === obj1;
      }),
    ).toBe(1);

    expect(currentIndex).toBe(2);
  });

  it("should give give a context if the third argument is provided", () => {
    const obj1 = {};
    const obj2 = {};
    const context = {};
    const arr = [obj2, obj1, obj2, obj1];
    arrayFindIndex(
      arr,
      function (this: unknown) {
        expect(this).toBe(context);
        return false;
      },
      context,
    );
  });

  if (typeof initialArrayFindIndex === "function") {
    it("should call the original array.findIndex function if it exists", () => {
      (Array.prototype as { findIndex: unknown }).findIndex = initialArrayFindIndex;
      const obj1 = {};
      const obj2 = {};
      const context = {};
      const arr = [obj2, obj1, obj2, obj1];
      const spy = vi.spyOn(arr as unknown as { findIndex: () => unknown }, "findIndex");

      let currentIndex = 0;
      const predicate = function (
        this: unknown,
        obj: unknown,
        index: number,
        cArr: unknown[],
      ): boolean {
        expect(this).toBe(context);
        expect(index).toBe(currentIndex++);
        expect(cArr).toBe(arr);
        return obj === obj1;
      };
      expect(arrayFindIndex(arr, predicate, context)).toBe(1);
      expect(currentIndex).toBe(2);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(predicate, context);
    });
  }
});
