import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'

const COMPONENTS = {
  a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
  img: ({ alt, ...props }) => (
    <figure className="wiki-figure">
      <img {...props} alt={alt || ''} loading="lazy" />
      {alt ? <figcaption>{alt}</figcaption> : null}
    </figure>
  ),
  video: (props) => (
    <video {...props} controls className="wiki-video" />
  )
}

export default function MarkdownContent({ content }) {
  return (
    <div className="wiki-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={COMPONENTS}
      >
        {content || ''}
      </ReactMarkdown>
    </div>
  )
}
