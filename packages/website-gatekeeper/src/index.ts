export * from "./website.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("Website Gatekeeper worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
