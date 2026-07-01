import { assertPiSdkCompatibility } from "../src/pi-sdk-compatibility.js";

describe("assertPiSdkCompatibility", () => {
  it("accepts a Pi SDK that exposes the pi-ai compatibility entrypoint", () => {
    expect(() => assertPiSdkCompatibility((specifier) => {
      if (specifier === "@earendil-works/pi-ai/compat") {
        return "/mock/node_modules/@earendil-works/pi-ai/dist/compat.js";
      }
      throw new Error(`Cannot resolve ${specifier}`);
    })).not.toThrow();
  });

  it("throws a clear setup error when the resolved Pi SDK is too old", () => {
    expect(() => assertPiSdkCompatibility(() => {
      throw new Error("Package subpath './compat' is not defined by exports");
    })).toThrow(
      "TelePi requires @earendil-works Pi SDK packages >=0.80.0 <0.81.0",
    );
  });
});
