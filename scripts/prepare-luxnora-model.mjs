import {mkdir,mkdtemp,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

const root=process.argv[2];
if(!root) throw new Error("Usage: node scripts/prepare-luxnora-model.mjs <output directory>");
const target=join(root,"luxnora-assets"),model=join(target,"ruri-v3-30m");
const temp=await mkdtemp(join(tmpdir(),"luxnora-runtime-"));
const exec=promisify(execFile);
const source="https://huggingface.co/cl-nagoya/ruri-v3-30m/resolve/24899e5de370b56d179604a007c0d727bf144504/";
const converted="https://huggingface.co/onnx-community/ruri-v3-30m-ONNX/resolve/1b41a27f31213fc55a9c4653c067770e39406408/";
async function save(base,name,destination=join(model,name),check) {
  const response=await fetch(base+name,{signal:AbortSignal.timeout(120000)});
  if(!response.ok) throw new Error(name+" HTTP "+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(check&&createHash("sha256").update(bytes).digest("hex")!==check) throw new Error("Model checksum mismatch");
  await writeFile(destination,bytes);
}
async function runtime() {
  const {stdout}=await exec("npm",["pack","@huggingface/transformers@3.8.1","--json","--pack-destination",temp]);
  const [{filename}]=JSON.parse(stdout);
  for(const [from,to] of [
    ["dist/transformers.min.js","transformers.min.js"],
    ["dist/ort-wasm-simd-threaded.jsep.mjs","wasm/ort-wasm-simd-threaded.jsep.mjs"],
    ["dist/ort-wasm-simd-threaded.jsep.wasm","wasm/ort-wasm-simd-threaded.jsep.wasm"],
    ["LICENSE","TRANSFORMERS-LICENSE"],
  ]) {
    const result=await exec("tar",["-xOf",join(temp,filename),"package/"+from],{encoding:"buffer",maxBuffer:48*1024*1024});
    await writeFile(join(target,to),result.stdout);
  }
}
try {
  await Promise.all([mkdir(join(model,"onnx"),{recursive:true}),mkdir(join(target,"wasm"),{recursive:true})]);
  await Promise.all([
    ...["tokenizer.json","tokenizer_config.json","special_tokens_map.json"].map(name=>save(source,name)),
    save(source,"README.md",join(model,"UPSTREAM.md")),
    save(converted,"config.json"),
    save(converted,"onnx/model_quantized.onnx",undefined,"bd07545fa4eb8e7765939536944da1138a7e61441d81633adfa1faf218df6bb1"),
    runtime(),
  ]);
  await writeFile(join(target,"ready.json"),JSON.stringify({model:"ruri-v3-30m",revision:"1b41a27f",license:"Apache-2.0"}));
} finally {await rm(temp,{recursive:true,force:true});}
