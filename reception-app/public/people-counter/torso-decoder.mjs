// Read BodyPix's public baseModel outputs directly. Argmax supplies the part ID
// without the stock decoder's integer matrix multiplication (unsupported by
// TFJS's WASM backend). No face or pose decoding is needed for torso counting.
export async function inferPartMask(tf, bodyPix, model, frame) {
  const sourceH = frame.shape?.[0] || frame.height, sourceW = frame.shape?.[1] || frame.width;
  const scale = Math.min(1, 320 / sourceW), width = Math.round(sourceW * scale), height = Math.round(sourceH * scale);
  const targetW = Math.floor(width / 16) * 16 + 1, targetH = Math.floor(height / 16) * 16 + 1;
  const targetAspect = targetW / targetH;
  const padX = width / height < targetAspect ? Math.round((height * targetAspect - width) / 2) : 0;
  const padY = width / height >= targetAspect ? Math.round((width / targetAspect - height) / 2) : 0;
  const tensors = tf.tidy(() => {
    const input = frame.shape ? frame : tf.browser.fromPixels(frame);
    const small = tf.image.resizeBilinear(input, [height, width]);
    const padded = tf.pad3d(small, [[padY, padY], [padX, padX], [0, 0]]);
    const resized = tf.image.resizeBilinear(padded, [targetH, targetW]);
    const output = model.baseModel.predict(resized);
    const size = [height, width], target = [targetH, targetW], padding = [[padY, padY], [padX, padX]];
    const person = bodyPix.scaleAndCropToInputTensorShape(output.segmentation, size, target, padding, true).squeeze();
    const parts = bodyPix.scaleAndCropToInputTensorShape(output.partHeatmaps, size, target, padding, true).argMax(2);
    return { person, parts };
  });
  try {
    const [scores, ids] = await Promise.all([tensors.person.data(), tensors.parts.data()]);
    const data = new Int32Array(ids);
    for (let i = 0; i < data.length; i++) if (scores[i] <= 0.5) data[i] = -1;
    return { width, height, data };
  } finally {
    tensors.person.dispose(); tensors.parts.dispose();
  }
}
