FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV OPENKNX_XML_NAVIGATOR_PORT=4173
ENV OPENKNX_XML_NAVIGATOR_SOURCE_DIRS=examples;data
ENV OPENKNX_XML_NAVIGATOR_DEFAULT_SOURCE=examples/LedDimmerAB.debug.xml

EXPOSE 4173

CMD ["npm", "start"]
