// Pricing rates are defined as follows:
// - API calls: cents per call
// - AI tokens: cents per 1,000 tokens

module.exports = {
  // 5 cents per API call
  API_CALL_RATE: 5,
  
  // 4 cents per 1,000 fresh input tokens
  INPUT_TOKEN_RATE: 4,
  
  // 1 cent per 1,000 cached input tokens (25% of fresh input cost)
  CACHED_INPUT_TOKEN_RATE: 1,
  
  // 12 cents per 1,000 output tokens
  OUTPUT_TOKEN_RATE: 12,
  
  // 12 cents per 1,000 reasoning tokens (must strictly match output rate)
  REASONING_TOKEN_RATE: 12,
};
