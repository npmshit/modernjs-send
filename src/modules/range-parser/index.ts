/*!
 * range-parser
 * Copyright(c) 2012-2014 TJ Holowaychuk
 * Copyright(c) 2015-2016 Douglas Christopher Wilson
 * Copyright(c) 2018 Zongmin Lei <leizongmin@gmail.com>
 * MIT Licensed
 */

interface IRangeItem {
  start: number;
  end: number;
  index?: number;
}

interface IRanges extends Array<IRangeItem> {
  type?: string;
}

/**
 * Parse "Range" header `str` relative to the given file `size`.
 *
 * @param {Number} size
 * @param {String} str
 * @param {Object} [options]
 * @return {Array}
 */
export function rangeParser(size: number, str: string, options: { combine: boolean }) {
  const index = str.indexOf("=");

  if (index === -1) {
    return -2;
  }

  // split the range string
  const arr = str.slice(index + 1).split(",");
  const ranges: IRanges = [];

  // add ranges type
  ranges.type = str.slice(0, index);

  // parse all ranges
  for (let i = 0; i < arr.length; i++) {
    const range = arr[i].split("-");
    let start = parseInt(range[0], 10);
    let end = parseInt(range[1], 10);

    // -nnn
    if (isNaN(start)) {
      start = size - end;
      end = size - 1;
      // nnn-
    } else if (isNaN(end)) {
      end = size - 1;
    }

    // limit last-byte-pos to current length
    if (end > size - 1) {
      end = size - 1;
    }

    // invalid or unsatisifiable
    if (isNaN(start) || isNaN(end) || start > end || start < 0) {
      continue;
    }

    // add range
    ranges.push({
      start: start,
      end: end,
    });
  }

  if (ranges.length < 1) {
    // unsatisifiable
    return -1;
  }

  return options && options.combine ? combineRanges(ranges) : ranges;
}

/**
 * Combine overlapping & adjacent ranges.
 */
function combineRanges(ranges: IRanges) {
  const ordered = ranges.map(mapWithIndex).sort(sortByRangeStart);

  let j = 0;
  for (let i = 1; i < ordered.length; i++) {
    const range = ordered[i];
    const current = ordered[j];

    if (range.start > current.end + 1) {
      // next range
      ordered[++j] = range;
    } else if (range.end > current.end) {
      // extend range
      current.end = range.end;
      current.index = Math.min(current.index, range.index);
    }
  }

  // trim ordered array
  ordered.length = j + 1;

  // generate combined range
  const combined: IRanges = ordered.sort(sortByRangeIndex).map(mapWithoutIndex);

  // copy ranges type
  combined.type = ranges.type;

  return combined;
}

/**
 * Map function to add index value to ranges.
 */
function mapWithIndex(range: IRangeItem, index: any) {
  return {
    start: range.start,
    end: range.end,
    index: index,
  };
}

/**
 * Map function to remove index value from ranges.
 */
function mapWithoutIndex(range: IRangeItem) {
  return {
    start: range.start,
    end: range.end,
  };
}

/**
 * Sort function to sort ranges by index.
 */
function sortByRangeIndex(a: IRangeItem, b: IRangeItem) {
  return a.index! - b.index!;
}

/**
 * Sort function to sort ranges by start position.
 */
function sortByRangeStart(a: IRangeItem, b: IRangeItem) {
  return a.start - b.start;
}
