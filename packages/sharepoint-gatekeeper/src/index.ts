export * from "./sharepoint.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("SharePoint Gatekeeper worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
