import Route from '@ember/routing/route';
import { action } from '@ember/object';
import { inject as service } from '@ember/service';
import ENV from '@cardstack/cardhost/config/environment'

const { environment } = ENV;
export default class IndexRoute extends Route {
  @service data;

  async model() {
    // prime the store with seed models
    if (environment === 'development') {
      await this.data.getCard('local-hub::article-card::why-doors', 'isolated');
    }
    return await this.data.allCardsInStore();
  }

  @action
  refreshModel() {
    this.refresh();
  }
}