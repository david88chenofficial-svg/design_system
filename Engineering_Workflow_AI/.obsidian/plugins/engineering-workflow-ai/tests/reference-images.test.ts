import { describe, expect, it } from "vitest";
import { prepareReferenceImage, referenceImagePromptLabel } from "../src/reference-images";

describe("reference image assets", () => {
  it("creates a deterministic safe project path and preserves the binary data", () => {
    const prepared = prepareReferenceImage({
      name: "Seal diagram (rev 1).PNG",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,aGVsbG8=",
      projectRelativePath: ""
    });

    expect(prepared.image.projectRelativePath)
      .toBe("Reference Images/Seal-diagram-rev-1-2cf24dba5fb0.png");
    expect(Buffer.from(prepared.data).toString("utf8")).toBe("hello");
    expect(referenceImagePromptLabel(prepared.image)).toContain(
      "PROJECT-RELATIVE ASSET PATH: Reference Images/Seal-diagram-rev-1-2cf24dba5fb0.png"
    );
  });

  it("rejects mismatched or unsupported image data", () => {
    expect(() => prepareReferenceImage({
      name: "wrong.png",
      mimeType: "image/png",
      dataUrl: "data:image/jpeg;base64,aGVsbG8=",
      projectRelativePath: ""
    })).toThrow(/does not match/);
    expect(() => prepareReferenceImage({
      name: "vector.svg",
      mimeType: "image/svg+xml",
      dataUrl: "data:image/svg+xml;base64,aGVsbG8=",
      projectRelativePath: ""
    })).toThrow(/Unsupported/);
  });
});
