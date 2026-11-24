import { describe, expect, it } from "vitest";
import { isSoftwareGpuName } from "./deviceTier";

describe("isSoftwareGpuName", () => {
  it.each([
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)",
    "Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)",
    "Microsoft Basic Render Driver",
    "Apple Software Renderer",
  ])("recognises %s", (renderer) => {
    expect(isSoftwareGpuName(renderer)).toBe(true);
  });

  it.each([
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "Apple M2 Pro",
    "",
  ])("leaves hardware rendering (%s) alone", (renderer) => {
    expect(isSoftwareGpuName(renderer)).toBe(false);
  });
});
