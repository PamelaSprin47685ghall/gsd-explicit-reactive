
    export const DISPATCH_RULES = [
      { name: "planning → plan-slice", match: async (args) => ({ prompt: "Original prompt" }) },
      { name: "executing → reactive-execute (parallel dispatch)", match: async () => null }
    ];
  