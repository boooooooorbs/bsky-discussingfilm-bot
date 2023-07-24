import 'https://deno.land/std@0.193.0/dotenv/load.ts';
import { Image, GIF } from 'https://deno.land/x/imagescript@1.2.15/mod.ts';
import { parseFeed } from 'https://deno.land/x/rss@0.6.0/mod.ts';
import AtprotoAPI from 'npm:@atproto/api';
import ogs from 'npm:open-graph-scraper';

const lastExecutionTime = await Deno.readTextFile('.timestamp');
console.log(lastExecutionTime.trim());

// rss feedから記事リストを取得
const getItemList = async () => {
  const response = await fetch(Deno.env.get('RSS_URL') || '');
  const xml = await response.text();
  const feed = await parseFeed(xml);

  const foundList = feed.entries.reverse().filter((item) => {
    return (
      item.published &&
      new Date(lastExecutionTime.trim()) < new Date(item.published)
    );
  });
  return foundList;
};
const itemList = await getItemList();
console.log(itemList);

// 対象がなかったら終了
if (!itemList.length) {
  console.log('not found feed item');
  Deno.exit(0);
}

// Blueskyに接続
const { BskyAgent, RichText } = AtprotoAPI;
const service = 'https://bsky.social';
const agent = new BskyAgent({ service });
const identifier = Deno.env.get('BLUESKY_IDENTIFIER') || '';
const password = Deno.env.get('BLUESKY_PASSWORD') || '';
await agent.login({ identifier, password });

// 取得した記事リストをループ処理
for await (const item of itemList) {
  // 最終実行時間を更新
  await Deno.writeTextFile(
    '.timestamp',
    item.published
      ? new Date(item.published).toISOString()
      : new Date().toISOString()
  );

  const title = item.title?.value || '';
  const description = item.description?.value || '';
  const link = item.links[0].href || '';

  // 投稿予定のテキストを作成
  const text = `${title}\n${link}`;

  const pattern =
    /https?:\/\/[-_.!~*\'()a-zA-Z0-9;\/?:\@&=+\$,%#\u3000-\u30FE\u4E00-\u9FA0\uFF01-\uFFE3]+/g;
  const [url] = text.match(pattern) || [''];

  // URLからOGPの取得
  const getOgp = async (url: string) => {
    const res = await fetch(url, { headers: { 'user-agent': 'Twitterbot' } });
    const html = await res.text();

    const { result } = await ogs({ html });
    console.log(result);

    if (!result.ogImage || !result.ogTitle) {
      return {};
    }

    const ogImage = result.ogImage?.at(0);
    const response = await fetch(ogImage?.url || '');
    const buffer = await response.arrayBuffer();

    // TODO: 画像を1MB以下になるまでリサイズしたい
    let resizedImage, mimeType;
    if (ogImage?.type === 'gif') {
      mimeType = 'image/gif';
      const gif = await GIF.decode(buffer);
      resizedImage = gif.encode();
    } else {
      mimeType = 'image/jpeg';
      const image = await Image.decode(buffer);
      resizedImage =
        image.width < 1024 && image.height < 1024
          ? await image.encodeJPEG()
          : await image
              .resize(
                image.width >= image.height ? 1024 : Image.RESIZE_AUTO,
                image.width < image.height ? 1024 : Image.RESIZE_AUTO
              )
              .encodeJPEG();
    }

    return {
      type: mimeType,
      image: resizedImage,
    };
  };
  const og = await getOgp(url);

  const rt = new RichText({ text });
  await rt.detectFacets(agent);
  if (rt.text.length > 300) {
    // 300文字以上は投稿しない
    continue;
  }

  const postObj = {
    $type: 'app.bsky.feed.post',
    text: rt.text,
    facets: rt.facets,
  };

  if (og.image) {
    // 画像をアップロード
    const uploadedImage = await agent.uploadBlob(og.image, {
      encoding: og.type,
    });

    // 投稿オブジェクトに画像を追加
    postObj.embed = {
      $type: 'app.bsky.embed.external',
      external: {
        uri: url,
        thumb: {
          $type: 'blob',
          ref: {
            $link: uploadedImage.data.blob.ref.toString(),
          },
          mimeType: uploadedImage.data.blob.mimeType,
          size: uploadedImage.data.blob.size,
        },
        title,
        description,
      },
    };
  }
  console.log(postObj);
  const result = await agent.post(postObj);
  console.log(result);
}
