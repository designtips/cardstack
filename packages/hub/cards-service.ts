import { Session } from "./session";
import { Card, CardWithId, CardId } from "./card";
import { CARDSTACK_PUBLIC_REALM } from "./realm";
import CardstackError from "./error";
import { myOrigin } from "./origin";
import { search as scaffoldSearch, validate } from "./scaffolding";
import { getOwner, inject } from "./dependency-injection";
import { SingleResourceDoc } from "jsonapi-typescript";
import { Query } from "./query";

export default class CardsService {
  pgclient = inject("pgclient");

  async create(
    session: Session,
    realm: URL,
    doc: SingleResourceDoc
  ): Promise<CardWithId> {
    let realmCard = await this.getRealm(realm);
    let writerFactory = await realmCard.loadFeature("writer");
    if (!writerFactory) {
      throw new CardstackError(`realm "${realm.href}" is not writable`, {
        status: 403
      });
    }
    let writer = await getOwner(this).instantiate(writerFactory, realmCard);
    let card: Card = new Card(doc, realm);
    await validate(null, card, realmCard);

    let upstreamIdToWriter = card.upstreamId;
    let { saved, id: upstreamIdFromWriter } = await writer.create(
      session,
      await card.asUpstreamDoc(),
      upstreamIdToWriter
    );
    if (upstreamIdToWriter && upstreamIdFromWriter !== upstreamIdToWriter) {
      throw new CardstackError(
        `Writer plugin for realm ${realm.href} tried to change a localId it's not allowed to change`
      );
    }
    card.localId =
      typeof upstreamIdFromWriter === "object"
        ? upstreamIdFromWriter.localId
        : upstreamIdFromWriter;
    card.patch(saved.jsonapi);
    card.assertHasIds();

    let batch = this.pgclient.beginBatch();
    await batch.save(card);
    await batch.done();

    return card;
  }

  async search(_session: Session, query: Query): Promise<{ cards: CardWithId[] }> {
    let { cards } = await this.pgclient.search(_session, query);
    if (cards.length === 0) {
      cards = await scaffoldSearch(query);
    }
    return { cards };
  }

  async get(_session: Session, id: CardId): Promise<CardWithId> {
    // this exists to throw if there's no such realm. We're not using the return
    // value yet but we will onc we implement custom searchers and realm grants.
    await this.getRealm(id.realm);
    return await this.pgclient.get(_session, id);
  }

  private async getRealm(realm: URL): Promise<CardWithId> {
    // This searches by realm and localId. Even though it doesn't search by
    // originalRealm, it's unique because of the special property that Realm
    // cards have that their localId contains the complete URL to the realm. So
    // localIds created on different hubs will never collide.
    //
    // We don't necessarily know the originalRealm we're looking for because we
    // don't know whose meta realm this realm was originally created in.
    let { cards: realms } = await this.search(Session.INTERNAL_PRIVILEGED, {
      filter: {
        type: { realm: CARDSTACK_PUBLIC_REALM, localId: "realm" },
        eq: {
          // the special meta-realm on each origin has restrictive but not
          // entirely closed off permissions that let users create / update /
          // delete their own Realm cards. The set of relam cards in the
          // meta-realm determines all the realms this hub (origin) knows
          // about. Some of the realms in here can live on other origins, and
          // that's fine.
          realm: `${myOrigin}/api/realms/meta`,
          "local-id": realm.href
        }
      }
    });

    if (realms.length === 0) {
      throw new CardstackError(`no such realm`, { status: 400 });
    }
    return realms[0];
  }
}



declare module "@cardstack/hub/dependency-injection" {
  interface KnownServices {
    cards: CardsService;
  }
}