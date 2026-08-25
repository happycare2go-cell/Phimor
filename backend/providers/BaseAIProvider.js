class BaseAIProvider {
  async generateStructured() {
    throw new Error('AIProvider.generateStructured() must be implemented');
  }
}

module.exports = { BaseAIProvider };
