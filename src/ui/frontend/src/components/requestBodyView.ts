export type RequestBodyDisplay =
  | { encoding: "utf-8"; text: string }
  | { encoding: "base64"; text: string };

export function displayRequestBody(data: string): RequestBodyDisplay {
  const binary = atob(data);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  try {
    return {
      encoding: "utf-8",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return { encoding: "base64", text: data };
  }
}
