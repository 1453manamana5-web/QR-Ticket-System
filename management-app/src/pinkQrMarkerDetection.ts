export type PinkQrMarker = {
  centerXPercent: number;
  centerYPercent: number;
  sizePercent: number;
  candidateCount: number;
};

export type PresetTicketRatio =
  | "16:9"
  | "4:3"
  | "3:2"
  | "card"
  | "square"
  | "9:16";

export type TicketRatioDetection = {
  cardRatio: PresetTicketRatio;
  label: string;
  width: number;
  height: number;
};

export type TicketBackgroundAnalysis = {
  imageWidth: number;
  imageHeight: number;
  ratio: TicketRatioDetection;
  marker: PinkQrMarker | null;
};

const ticketRatioPresets: TicketRatioDetection[] = [
  { cardRatio: "16:9", label: "16:9", width: 16, height: 9 },
  { cardRatio: "4:3", label: "4:3", width: 4, height: 3 },
  { cardRatio: "3:2", label: "3:2", width: 3, height: 2 },
  { cardRatio: "card", label: "カード比率", width: 1.586, height: 1 },
  { cardRatio: "square", label: "正方形", width: 1, height: 1 },
  { cardRatio: "9:16", label: "9:16", width: 9, height: 16 },
];

export function findClosestTicketRatio(imageWidth: number, imageHeight: number): TicketRatioDetection {
  if (imageWidth <= 0 || imageHeight <= 0) return ticketRatioPresets[0];
  const imageRatio = imageWidth / imageHeight;
  return ticketRatioPresets.reduce((closestRatio, candidate) => {
    const closestDifference = Math.abs(Math.log(imageRatio / (closestRatio.width / closestRatio.height)));
    const candidateDifference = Math.abs(Math.log(imageRatio / (candidate.width / candidate.height)));
    return candidateDifference < closestDifference ? candidate : closestRatio;
  });
}

export function mapMarkerToTicketRatio(
  marker: PinkQrMarker,
  imageWidth: number,
  imageHeight: number,
  ticketRatio: TicketRatioDetection
): PinkQrMarker {
  const imageRatio = imageWidth / imageHeight;
  const cardRatio = ticketRatio.width / ticketRatio.height;
  if (!Number.isFinite(imageRatio) || imageRatio <= 0) return marker;

  if (imageRatio > cardRatio) {
    const displayedHeightRatio = cardRatio / imageRatio;
    const topOffset = (1 - displayedHeightRatio) / 2;
    return {
      ...marker,
      centerYPercent: (topOffset + (marker.centerYPercent / 100) * displayedHeightRatio) * 100,
    };
  }

  if (imageRatio < cardRatio) {
    const displayedWidthRatio = imageRatio / cardRatio;
    const leftOffset = (1 - displayedWidthRatio) / 2;
    return {
      ...marker,
      centerXPercent: (leftOffset + (marker.centerXPercent / 100) * displayedWidthRatio) * 100,
      sizePercent: marker.sizePercent * displayedWidthRatio,
    };
  }

  return marker;
}

type MarkerCandidate = PinkQrMarker & { score: number };

function isPinkPixel(red: number, green: number, blue: number, alpha: number) {
  if (alpha < 170) return false;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const difference = maximum - minimum;
  const value = maximum / 255;
  const saturation = maximum === 0 ? 0 : difference / maximum;
  if (value < 0.58 || saturation < 0.38 || red < 175 || blue < 75) return false;

  let hue = 0;
  if (difference !== 0) {
    if (maximum === red) hue = 60 * (((green - blue) / difference) % 6);
    else if (maximum === green) hue = 60 * ((blue - red) / difference + 2);
    else hue = 60 * ((red - green) / difference + 4);
  }
  if (hue < 0) hue += 360;
  return hue >= 285 && hue <= 350;
}

export function detectPinkQrMarker(pixels: Uint8ClampedArray, width: number, height: number): PinkQrMarker | null {
  if (width <= 0 || height <= 0 || pixels.length < width * height * 4) return null;

  const pixelCount = width * height;
  const pinkMask = new Uint8Array(pixelCount);
  const visited = new Uint8Array(pixelCount);

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const colorIndex = pixelIndex * 4;
    if (isPinkPixel(pixels[colorIndex], pixels[colorIndex + 1], pixels[colorIndex + 2], pixels[colorIndex + 3])) {
      pinkMask[pixelIndex] = 1;
    }
  }

  const stack = new Int32Array(pixelCount);
  const minimumArea = Math.max(36, Math.round(pixelCount * 0.00025));
  const candidates: MarkerCandidate[] = [];

  for (let startIndex = 0; startIndex < pixelCount; startIndex += 1) {
    if (pinkMask[startIndex] === 0 || visited[startIndex] === 1) continue;

    let stackLength = 1;
    let area = 0;
    let minimumX = width;
    let maximumX = 0;
    let minimumY = height;
    let maximumY = 0;

    stack[0] = startIndex;
    visited[startIndex] = 1;

    while (stackLength > 0) {
      stackLength -= 1;
      const currentIndex = stack[stackLength];
      const x = currentIndex % width;
      const y = Math.floor(currentIndex / width);

      area += 1;
      minimumX = Math.min(minimumX, x);
      maximumX = Math.max(maximumX, x);
      minimumY = Math.min(minimumY, y);
      maximumY = Math.max(maximumY, y);

      const neighbors = [
        x > 0 ? currentIndex - 1 : -1,
        x < width - 1 ? currentIndex + 1 : -1,
        y > 0 ? currentIndex - width : -1,
        y < height - 1 ? currentIndex + width : -1,
      ];

      for (const neighbor of neighbors) {
        if (neighbor >= 0 && pinkMask[neighbor] === 1 && visited[neighbor] === 0) {
          visited[neighbor] = 1;
          stack[stackLength] = neighbor;
          stackLength += 1;
        }
      }
    }

    const componentWidth = maximumX - minimumX + 1;
    const componentHeight = maximumY - minimumY + 1;
    const longerSide = Math.max(componentWidth, componentHeight);
    const shorterSide = Math.min(componentWidth, componentHeight);
    const squareness = shorterSide / longerSide;
    const fillRatio = area / (componentWidth * componentHeight);
    const widthPercent = (componentWidth / width) * 100;
    const heightPercent = (componentHeight / height) * 100;

    if (
      area < minimumArea ||
      squareness < 0.78 ||
      fillRatio < 0.5 ||
      widthPercent < 2 ||
      widthPercent > 55 ||
      heightPercent > 75
    ) continue;

    candidates.push({
      centerXPercent: (((minimumX + maximumX) / 2 + 0.5) / width) * 100,
      centerYPercent: (((minimumY + maximumY) / 2 + 0.5) / height) * 100,
      sizePercent: widthPercent,
      candidateCount: 0,
      score: area * fillRatio * squareness,
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.score - left.score);
  const bestCandidate = candidates[0];

  return {
    centerXPercent: bestCandidate.centerXPercent,
    centerYPercent: bestCandidate.centerYPercent,
    sizePercent: bestCandidate.sizePercent,
    candidateCount: candidates.length,
  };
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("背景画像を解析できませんでした。"));
    image.src = dataUrl;
  });
}

export async function analyzeTicketBackgroundFromDataUrl(dataUrl: string): Promise<TicketBackgroundAnalysis> {
  const image = await loadImage(dataUrl);
  const maximumDimension = 1400;
  const scale = Math.min(1, maximumDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("画像解析を開始できませんでした。");

  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const ratio = findClosestTicketRatio(image.naturalWidth, image.naturalHeight);
  const marker = detectPinkQrMarker(imageData.data, width, height);

  return {
    imageWidth: image.naturalWidth,
    imageHeight: image.naturalHeight,
    ratio,
    marker: marker === null ? null : mapMarkerToTicketRatio(marker, image.naturalWidth, image.naturalHeight, ratio),
  };
}
