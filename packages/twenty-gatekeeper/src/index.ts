export * from "./twenty.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("Twenty Gatekeeper worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
